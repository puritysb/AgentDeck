package dev.agentdeck.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

@Serializable
data class TimelineEntry(
    val timestamp: Long,
    val type: String,
    val summary: String,
    val detail: String? = null,
    val agentType: String? = null,
    val projectName: String? = null,
    val sessionId: String? = null,
    val runId: String? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val status: String? = null,
    val automated: Boolean? = null,
    /** APME task id. Set on task_start/task_end and on every turn entry inside the task scope. */
    val taskId: String? = null,
    /** Only on task_end. todo_complete | clear | session_end | manual | idle_gap. */
    val boundarySignal: String? = null,
    /** "llm" | "heuristic" | "none". Lets clients suppress the detail pane
     *  when the heuristic gave up and the body is just the raw response. */
    val summaryKind: String? = null,
    /**
     * Task-judge rollup, attached on the SECOND `task_end` emit the runner
     * fires once the LLM judge resolves (5–30 s after the boundary). Stores
     * upsert by (type, taskId) — see `upsertEntry`. Nil on the initial emit
     * and for non-task entries / pre-existing on-disk rows. Mirrors the four
     * task* fields on shared/src/timeline.ts::TimelineEntry.
     *   - `taskScore`    : 0..1 composite
     *   - `taskOutcome`  : "success" | "partial" | "fail" | "pending"
     *   - `taskCategory` : task_rollup category
     *   - `taskSummary`  : one-line judge summary
     */
    val taskScore: Double? = null,
    val taskOutcome: String? = null,
    val taskCategory: String? = null,
    val taskSummary: String? = null,
)

data class SubagentVisualActivity(
    val activeCount: Int = 0,
    val lastCompletedAt: Long? = null,
)

/**
 * Derive decorative parent/child activity from existing timeline rows.
 * This deliberately avoids a protocol/session-schema change: older clients
 * can ignore the same rows while newer terrariums draw their orbit accents.
 */
fun deriveSubagentActivity(
    entries: List<TimelineEntry>,
    now: Long = System.currentTimeMillis(),
    activeTtlMs: Long = 6 * 60 * 60 * 1000L,
): Map<String, SubagentVisualActivity> {
    data class ActiveStart(val timestamp: Long, val startedAt: Long?)

    val active = mutableMapOf<String, MutableList<ActiveStart>>()
    val completed = mutableMapOf<String, Long>()
    val ordered = entries.withIndex().sortedWith(
        compareBy<IndexedValue<TimelineEntry>> { it.value.timestamp }
            .thenBy { it.index }
    )

    for ((_, entry) in ordered) {
        val sessionId = entry.sessionId?.trim().orEmpty()
        if (sessionId.isEmpty()) continue
        val isSubagent = entry.summary.startsWith("Subagent ")
        val isTeamCompletion = entry.summary.startsWith("Team ")

        if (entry.type == "tool_exec" && isSubagent) {
            active.getOrPut(sessionId) { mutableListOf() }
                .add(ActiveStart(entry.timestamp, entry.startedAt))
            continue
        }
        if (entry.type != "tool_resolved" || (!isSubagent && !isTeamCompletion)) continue

        completed[sessionId] = maxOf(
            completed[sessionId] ?: 0,
            entry.endedAt ?: entry.timestamp,
        )
        if (!isSubagent) continue
        val starts = active[sessionId] ?: continue
        if (starts.isEmpty()) continue
        val matchingIndex = entry.startedAt
            ?.let { target -> starts.indexOfFirst { it.startedAt == target } }
            ?.takeIf { it >= 0 }
            ?: 0
        starts.removeAt(matchingIndex)
    }

    val result = mutableMapOf<String, SubagentVisualActivity>()
    for (sessionId in active.keys + completed.keys) {
        val activeCount = active[sessionId]
            .orEmpty()
            .count { now - it.timestamp <= activeTtlMs }
        val lastCompletedAt = completed[sessionId]
        if (activeCount > 0 || lastCompletedAt != null) {
            result[sessionId] = SubagentVisualActivity(activeCount, lastCompletedAt)
        }
    }
    return result
}

data class GroupedEntry(
    val entry: TimelineEntry,
    val count: Int = 1,
    val lastTs: Long = entry.timestamp,
    /** Assistant response body (chat_response) merged into this turn group.
     *  The daemon emits chat_start / chat_response / chat_end as three separate
     *  rows; the UI presents them as one turn row so users see a single
     *  evaluable unit instead of three near-duplicate lines. Mirrors
     *  `apple/AgentDeck/Model/Timeline.swift` GroupedEntry.mergedResponse. */
    val mergedResponse: TimelineEntry? = null,
    /** Terminator metadata (chat_end) merged into this turn group — carries the
     *  "Completed · Ns · topic" suffix. Mirrors Apple mergedCompletion. */
    val mergedCompletion: TimelineEntry? = null,
) {
    /** True when the assistant delivered something for this turn (response body
     *  or completion metadata). UIs use it to stop the chat_start spinner and
     *  swap its icon to the completed glyph — otherwise a merged, completed
     *  turn would spin forever because `chat_start` always maps to the Running
     *  icon. Mirrors Apple GroupedEntry.hasResponse. */
    val hasResponse: Boolean get() = mergedResponse != null || mergedCompletion != null
}

/**
 * Collapse the raw timeline into display groups.
 *
 * Two distinct collapses happen here (mirrors
 * `apple/AgentDeck/Model/Timeline.swift::groupConsecutive`):
 *  1. **Turn merge** — an in-flight `chat_start` absorbs the `chat_response`
 *     and `chat_end` the daemon emits for the same turn, so one user prompt
 *     renders as ONE row instead of three. This is what keeps OpenClaw cron
 *     turns (chat_start + chat_response, each with different text) from
 *     rendering as two rows the way Android used to. A standalone
 *     `chat_response` likewise absorbs a trailing `chat_end`.
 *  2. **Same-type run collapse** — consecutive same-type(+summary) rows fold
 *     into one `×count` group (`canGroup`): tool_request 10s, chat_end/default
 *     60s.
 */
/** How many prior groups a turn child (chat_response/chat_end) may scan back
 *  through to find its chat_start. With several agents running concurrently,
 *  other sessions' rows interleave between a prompt and its completion —
 *  merging only into the immediately-previous group (the old behaviour) made
 *  every busy-dashboard turn render as 2-3 scattered rows with a spinner that
 *  never stopped. Bounded so a pathological backlog can't go quadratic. */
private const val TURN_MERGE_LOOKBACK = 40
private const val TURN_MERGE_MAX_GAP_MS = 12 * 60 * 60 * 1000L

fun groupConsecutive(entries: List<TimelineEntry>): List<GroupedEntry> {
    if (entries.isEmpty()) return emptyList()
    val groups = mutableListOf<GroupedEntry>()
    for (entry in entries) {
        val isTaskMarker = entry.type == "task_start" || entry.type == "task_end"
        val last = groups.lastOrNull()
        if (!isTaskMarker && last != null) {
            // Turn merge: a chat_response/chat_end folds into the most recent
            // same-context turn group, looking past interleaved rows from
            // other sessions.
            if (tryMergeTurnChild(groups, entry)) continue

            // Same-type consecutive run collapse (×count) — keep latest entry.
            // Task hierarchy markers never group — each is a unique unit of work.
            if (last.entry.type != "task_start" && last.entry.type != "task_end" &&
                canGroup(last, entry)
            ) {
                groups[groups.size - 1] = last.copy(
                    entry = entry,
                    count = last.count + 1,
                    lastTs = entry.timestamp,
                )
                continue
            }
        }
        groups.add(GroupedEntry(entry = entry, lastTs = entry.timestamp))
    }
    return groups
}

/**
 * Fold a turn child (chat_response / chat_end) into the group it belongs to.
 *
 * Scans recent groups newest-first. The first same-context group encountered
 * decides the outcome — it is either this child's turn (merge) or evidence
 * that the turn is already closed / distinct (stop, render standalone). The
 * turn context (`sameTimelineContext` — taskId/runId/sessionId aware) plus the
 * chat_start anchor (child.startedAt == chat_start.ts) gate the merge —
 * wall-clock does not, because long responses push chat_end far past any
 * window. Synthetic starters ("Prompt sent" / "Connected") never absorb; the
 * trailing completion stays the visible row. Mirrors Apple
 * `apple/AgentDeck/Model/Timeline.swift::tryMergeTurnChild`.
 */
private fun tryMergeTurnChild(groups: MutableList<GroupedEntry>, entry: TimelineEntry): Boolean {
    val isResponse = entry.type == "chat_response"
    val isCompletion = entry.type == "chat_end"
    if (!isResponse && !isCompletion) return false

    var scanned = 0
    for (i in groups.indices.reversed()) {
        if (scanned++ >= TURN_MERGE_LOOKBACK) return false
        val g = groups[i]
        val ge = g.entry
        if (entry.timestamp - ge.timestamp > TURN_MERGE_MAX_GAP_MS) return false
        if (!sameTimelineContext(ge, entry)) continue

        when (ge.type) {
            "chat_start" -> {
                // Most recent same-context chat_start = this child's turn.
                // Any mismatch means the child's real turn row is missing —
                // merging further back would cross-talk onto an older turn.
                if (!isMeaningfulChatStart(ge)) return false
                if (g.mergedCompletion != null) return false
                if (!sameTurnAnchor(ge, entry)) return false
                if (isResponse) {
                    if (g.mergedResponse != null) return false
                    groups[i] = g.copy(mergedResponse = entry)
                } else {
                    groups[i] = g.copy(mergedCompletion = entry)
                }
                return true
            }
            "chat_response" -> {
                // A visible chat_response absorbs its trailing chat_end so
                // "Completed · …" metadata doesn't spawn its own row. A
                // response child stopping here means its own prompt row is
                // missing — standalone.
                if (isCompletion &&
                    g.mergedCompletion == null &&
                    sameResponseCompletionAnchor(ge, entry)
                ) {
                    groups[i] = g.copy(mergedCompletion = entry)
                    return true
                }
                return false
            }
            // Tool / model-call rows are activity *inside* the turn — look past
            // them to the turn's chat_start.
            "tool_request", "tool_resolved", "tool_exec", "model_call", "memory_recall" -> continue
            // Any other same-context row (chat_end, task marker…) is a turn
            // boundary for this session — stop scanning.
            else -> return false
        }
    }
    return false
}

/** True when `child` (chat_response/chat_end) belongs to `start`: the daemon
 *  stamps each child's `startedAt` with the originating chat_start's ts.
 *  Legacy emitters without `startedAt` permit the merge (bounded by iteration
 *  order). Mirrors Apple `sameTurnAnchor`. */
private fun sameTurnAnchor(start: TimelineEntry, child: TimelineEntry): Boolean {
    val anchor = child.startedAt ?: return true
    return anchor == start.timestamp
}

/** Anchor test for chat_response → chat_end absorption. Permits the merge when
 *  either side lacks `startedAt`. Mirrors Apple `sameResponseCompletionAnchor`. */
private fun sameResponseCompletionAnchor(response: TimelineEntry, completion: TimelineEntry): Boolean {
    val r = response.startedAt
    val c = completion.startedAt
    return if (r != null && c != null) r == c else true
}

private fun canGroup(group: GroupedEntry, entry: TimelineEntry): Boolean {
    val prev = group.entry
    if (prev.type != entry.type) return false
    // Task hierarchy markers never group — each task is a unique unit of work.
    if (entry.type == "task_start" || entry.type == "task_end") return false
    val window = when (entry.type) {
        "tool_request" -> 10_000L
        "chat_end" -> 60_000L
        else -> 60_000L
    }
    if (entry.timestamp - group.lastTs > window) return false
    if (!sameTimelineContext(prev, entry)) return false
    // chat_end: group by type only (keep latest summary)
    if (entry.type == "chat_end") return true
    // tool_request: group by type only
    if (entry.type == "tool_request") return true
    // others: same summary
    return prev.summary == entry.summary
}

class TimelineStore private constructor() {

    companion object {
        val instance: TimelineStore by lazy { TimelineStore() }
        private const val MAX_ENTRIES = 500
    }

    private val _entries = MutableStateFlow<List<TimelineEntry>>(emptyList())
    val entries: StateFlow<List<TimelineEntry>> = _entries.asStateFlow()

    fun addEntry(entry: TimelineEntry) {
        val normalized = normalizeTimelineEntryForStorage(entry) ?: return
        // Drop codex:otel-active noise at the **storage** layer so it never
        // reaches consumers that bypass `timelineDisplayGroups` (raw
        // `entries` flow readers, persistence in future, etc.) and so the
        // MAX_ENTRIES buffer doesn't age out useful rows behind it.
        // Mirrors Apple `DaemonTimelineStore` add-path filter.
        val list = _entries.value
        // 5s dedup — skip if same type+summary within window
        for (i in list.indices.reversed()) {
            val e = list[i]
            if (normalized.timestamp - e.timestamp > 5000) break
            if (e.type == normalized.type && e.summary == normalized.summary) return
        }
        // Sorted insert: live events normally arrive ascending (append
        // fast-path), but the daemon's deferred `task_start` is backdated to
        // the task's original startedAt — a plain append renders the TASK
        // header below the turns it groups until the next snapshot re-sort.
        val last = list.lastOrNull()
        _entries.value = if (last != null && normalized.timestamp < last.timestamp) {
            val insertAt = list.indexOfLast { it.timestamp <= normalized.timestamp } + 1
            (list.subList(0, insertAt) + normalized + list.subList(insertAt, list.size))
                .takeLast(MAX_ENTRIES)
        } else {
            (list + normalized).takeLast(MAX_ENTRIES)
        }
    }

    /** Update the most recent entry matching [type] using [transform]. */
    fun updateLastOfType(type: String, transform: (TimelineEntry) -> TimelineEntry) {
        val list = _entries.value.toMutableList()
        val idx = list.indexOfLast { it.type == type }
        if (idx >= 0) {
            list[idx] = transform(list[idx])
            _entries.value = list
        }
    }

    /** Update existing entry with same ts+type (1s tolerance), or add new.
     *
     *  taskId / boundarySignal / summaryKind are progressive: a heuristic
     *  chat_end can later be upserted with summaryKind='llm' + the LLM
     *  summary. Without propagating these, the dashboard keeps showing the
     *  pre-LLM kind and (for 'none' rows) the detail pane stays suppressed
     *  even after the LLM rescues it. */
    fun upsertEntry(entry: TimelineEntry) {
        val normalized = normalizeTimelineEntryForStorage(entry) ?: return
        // Storage-layer guard mirrors addEntry — never let an OTel low-
        // signal row enter, even via the upsert path used for progressive
        // summaryKind enrichment.
        val list = _entries.value.toMutableList()
        // Task-judge follow-up emits land 5–30 s after the initial boundary,
        // so the 1 s timestamp window won't match. For task_end rows, prefer
        // matching by (type, taskId) — that pair is stable across both emits
        // and lets the score-bearing update merge in place. Mirrors Apple
        // `DaemonTimelineStore::upsert`.
        val taskMatchIdx = if (normalized.type == "task_end" && !normalized.taskId.isNullOrEmpty()) {
            list.indexOfLast { it.type == "task_end" && it.taskId == normalized.taskId }
        } else -1
        val idx = if (taskMatchIdx >= 0) taskMatchIdx else {
            list.indexOfLast { it.type == normalized.type && kotlin.math.abs(it.timestamp - normalized.timestamp) < 1000L }
        }
        if (idx >= 0) {
            list[idx] = list[idx].copy(
                summary = normalized.summary,
                detail = normalized.detail ?: list[idx].detail,
                agentType = normalized.agentType ?: list[idx].agentType,
                projectName = normalized.projectName ?: list[idx].projectName,
                sessionId = normalized.sessionId ?: list[idx].sessionId,
                runId = normalized.runId ?: list[idx].runId,
                startedAt = normalized.startedAt ?: list[idx].startedAt,
                endedAt = normalized.endedAt ?: list[idx].endedAt,
                status = normalized.status ?: list[idx].status,
                automated = normalized.automated ?: list[idx].automated,
                taskId = normalized.taskId ?: list[idx].taskId,
                boundarySignal = normalized.boundarySignal ?: list[idx].boundarySignal,
                summaryKind = normalized.summaryKind ?: list[idx].summaryKind,
                taskScore = normalized.taskScore ?: list[idx].taskScore,
                taskOutcome = normalized.taskOutcome ?: list[idx].taskOutcome,
                taskCategory = normalized.taskCategory ?: list[idx].taskCategory,
                taskSummary = normalized.taskSummary ?: list[idx].taskSummary,
            )
            _entries.value = list
        } else {
            addEntry(normalized)
        }
    }

    fun addEntries(newEntries: List<TimelineEntry>) {
        // Same storage-layer guard as addEntry — bulk replay paths
        // (sessions_list snapshots, daemon resync) must not bypass the
        // OTel filter.
        val filtered = newEntries.mapNotNull { normalizeTimelineEntryForStorage(it) }
        _entries.value = (_entries.value + filtered)
            .distinctBy { "${it.timestamp}-${it.type}-${it.summary}" }
            .sortedBy { it.timestamp }
            .takeLast(MAX_ENTRIES)
    }

    /**
     * Replace the entire buffer with a daemon snapshot.
     *
     * The daemon's only `timeline_history` to a dashboard client is the FULL
     * store snapshot sent in `sendInitialState` (Android never issues a
     * session-scoped `query_session_timeline`). Merging it into the existing
     * buffer — the old behaviour — let re-emitted OpenClaw rows stack across
     * reconnects: the daemon re-stamps `ts` on log-tail replay, so the
     * `ts-type-summary` history dedup key shifts and the "same" row survives.
     * The tablet's Wi-Fi reconnect churn made this the dominant duplicate
     * source. Since the snapshot is authoritative, replace rather than merge.
     *
     * Ordering is safe: the daemon sends `connection` → `timeline_history`
     * before any live `timeline_event` on a fresh socket, and TCP preserves
     * order, so no live row is lost by replacing here.
     */
    fun replaceSnapshot(snapshot: List<TimelineEntry>) {
        val filtered = snapshot.mapNotNull { normalizeTimelineEntryForStorage(it) }
        _entries.value = filtered
            .distinctBy { "${it.timestamp}-${it.type}-${it.summary}" }
            .sortedBy { it.timestamp }
            .takeLast(MAX_ENTRIES)
    }

    fun clear() {
        _entries.value = emptyList()
    }
}
