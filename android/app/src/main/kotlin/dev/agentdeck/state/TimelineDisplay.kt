package dev.agentdeck.state

/**
 * Dashboard-facing timeline projection.
 *
 * The raw timeline is intentionally low-level; this projection turns it into
 * meaningful lifecycle rows. An in-flight chat_start remains visible until a
 * same-session completion arrives. Once a chat_response/model_response/chat_end
 * arrives, the completion row becomes the user-visible unit.
 */
fun timelineDisplayGroups(groups: List<GroupedEntry>): List<GroupedEntry> =
    groups.filter { group ->
        val entry = group.entry
        when {
            entry.type == "task_start" || entry.type == "task_end" ->
                shouldShowTaskMarker(entry, groups.map { it.entry })
            // Suppress codex:otel-active no-op tool noise (matches Apple).
            isLowSignalEntry(entry) -> false
            isTaskNotificationChatStart(entry) -> false
            isProgressChatResponse(entry) -> false
            entry.type == "chat_start" ->
                if (!hasLaterCompletion(entry, groups)) true
                else isMeaningfulChatStart(entry)
            entry.type == "model_call" ->
                !hasLaterCompletion(entry, groups)
            // chat_end is completion metadata for the response row. Keep it
            // standalone only when no response row exists for the same turn.
            entry.type == "chat_end" -> {
                if (entry.summaryKind == "progress") false
                else !hasPairedChatResponse(entry, groups) && !hasPairedChatStart(entry, groups)
            }
            else -> true
        }
    }

/**
 * True when the chat_start row has user-meaningful content (a real prompt) —
 * synthetic starters that the bridge inserts for lifecycle tracking are
 * dropped once a completion arrives. Mirrors `timelineIsMeaningfulChatStart`
 * in apple/AgentDeck/UI/Monitor/TimelineStripView.swift.
 */
internal fun isMeaningfulChatStart(entry: TimelineEntry): Boolean {
    val raw = entry.summary.trim()
    if (raw.isEmpty()) return false
    if (isTaskNotificationChatStart(entry)) return false
    val normalized = raw.lowercase()
    return normalized !in syntheticChatStarts
}

internal fun isTaskNotificationChatStart(entry: TimelineEntry): Boolean {
    if (entry.type != "chat_start") return false
    val raw = entry.summary.trim().lowercase()
    val detail = entry.detail?.trim()?.lowercase().orEmpty()
    return raw.startsWith("<task-notification>") || detail.startsWith("<task-notification>")
}

private val syntheticChatStarts = setOf(
    "prompt sent",
    "codex turn started",
    "starting chat",
    "connected",
    "resumed",
)

// One-row-per-task render contract — mirrors shared/src/timeline-task-display.ts
// (`timelineShouldRenderTaskRow` / `timelineTaskClosure` /
// `timelineTaskHeaderDisplay`) and Apple TimelineStripView.swift; update all
// three in the same commit.
//
// `task_end` is a DATA-ONLY closure record: it stops the in-flight spinner,
// carries the judge-result upsert, and is what the orphan reaper synthesizes —
// but it never renders as a standalone row. The `task_start` header folds the
// closure in instead. Bare "Task N" headers with no eval payload (own or
// closure) render nothing, so interrupted reaper closures leave no visible row.
internal fun shouldShowTaskMarker(entry: TimelineEntry, siblings: List<TimelineEntry>): Boolean {
    if (entry.type == "task_end") return false
    if (entry.type != "task_start") return true
    if (entry.taskCategory == "_empty") return false
    val closure = taskClosure(entry, siblings)
    if (closure?.taskCategory == "_empty") return false
    if (isMeaningfulTaskTitle(entry.summary)) return true
    return hasTaskEvalPayload(entry) || hasTaskEvalPayload(closure)
}

/** The matching `task_end` closure record for a `task_start` header, if it
 *  has arrived among [siblings]. Null for non-headers and open tasks. */
internal fun taskClosure(entry: TimelineEntry, siblings: List<TimelineEntry>): TimelineEntry? {
    if (entry.type != "task_start") return null
    val taskId = entry.taskId?.takeIf { it.isNotBlank() } ?: return null
    return siblings.firstOrNull { it.type == "task_end" && it.taskId == taskId }
}

private fun hasTaskEvalPayload(entry: TimelineEntry?): Boolean {
    if (entry == null) return false
    return entry.taskScore != null ||
        !entry.taskOutcome.isNullOrBlank() ||
        (!entry.taskCategory.isNullOrBlank() && entry.taskCategory != "_empty") ||
        !entry.taskSummary.isNullOrBlank()
}

/** Displayed pieces of a task header with its closure folded in. Mirrors
 *  `timelineTaskHeaderDisplay` in shared/src/timeline-task-display.ts. */
internal data class TaskHeaderDisplay(
    /** Own title when meaningful, else the judge's one-line summary, else raw. */
    val title: String,
    /** Closure label chip ("Session end · 2 turns · 6m 5s"); null while open. */
    val closureText: String?,
    /** True once the matching `task_end` exists. */
    val closed: Boolean,
    /** Badge inputs — closure fields win (the judge upserts onto the closure). */
    val taskScore: Double?,
    val taskOutcome: String?,
    /** Epoch ms the task closed at, for the pending → unscored transition. */
    val closedAtMs: Long?,
)

internal fun taskHeaderDisplay(entry: TimelineEntry, siblings: List<TimelineEntry>): TaskHeaderDisplay {
    val closure = taskClosure(entry, siblings)
    val ownTitle = entry.summary.trim()
    val summary = (closure?.taskSummary ?: entry.taskSummary)?.trim().orEmpty()
    val title = if (isMeaningfulTaskTitle(ownTitle)) ownTitle else summary.ifEmpty { ownTitle }
    val closureText = closure?.summary?.trim()?.takeIf { it.isNotEmpty() }
    val outcome = (closure?.taskOutcome ?: entry.taskOutcome)?.trim()?.takeIf { it.isNotEmpty() }
    return TaskHeaderDisplay(
        title = title,
        closureText = closureText,
        closed = closure != null,
        taskScore = closure?.taskScore ?: entry.taskScore,
        taskOutcome = outcome,
        closedAtMs = closure?.let { it.endedAt ?: it.timestamp },
    )
}

private fun isMeaningfulTaskTitle(raw: String): Boolean {
    val title = raw.trim()
    if (title.isEmpty()) return false
    if (Regex("""^task\s+\d+$""", RegexOption.IGNORE_CASE).matches(title)) return false
    if (Regex("""^작업\s*\d+$""").matches(title)) return false
    return true
}

/**
 * Low-signal tool entries that should not enter the device-facing timeline.
 * Mirrors `DaemonTimelineStore.shouldDropLowSignalEntry` and
 * `timelineIsLowSignalEntry` on Apple.
 *
 * Visible at package level so `TimelineStore` can drop these on the
 * **add** path too — Apple filters at storage AND display, so legacy
 * persisted entries never come back when timeline.json replays. Android
 * doesn't persist (in-memory store only) but the same guard keeps the
 * 500-entry buffer from aging out useful rows behind OTel noise.
 */
internal fun isLowSignalEntry(entry: TimelineEntry): Boolean {
    if (isOpenClawLowSignalResponse(entry)) return true

    if (entry.type !in lowSignalTypes) return false
    // Observed-agent tool hooks fire for every internal Bash/MCP/read/todowrite
    // action and can easily evict the actual turn/task rows from the bounded
    // timeline. APME still ingests the hook trajectory; the device timeline
    // keeps their chat/task lifecycle rows only. OpenCode had no suppression and
    // flooded its own turn with tool rows while Codex read clean. Antigravity is
    // included forward-compat (the observed-hook classifier already accepts
    // antigravity_* events).
    val isSubagentLifecycle = entry.type == "tool_exec" && entry.summary.trimStart().startsWith("Subagent ")
    if (!isSubagentLifecycle && (entry.agentType == "codex-cli" || entry.agentType == "codex-app" || entry.agentType == "opencode" || entry.agentType == "antigravity") && entry.type == "tool_exec") {
        return true
    }
    // Real signal in detail → keep regardless of placeholder raw. The
    // OpenClaw producer's detail format is
    //   `[status: X]\n[input: ...]\n[output: ...]`
    // with each line independently optional, so a detail of just
    // "status: running" alone is still placeholder noise — only
    // `input:` / `output:` lines (or any non-status line) qualify as
    // real signal. Codex stop-time review 2026-05-18.
    if (detailHasRealSignal(entry.detail)) return false
    val raw = entry.summary.trim().lowercase()
    if ((entry.agentType == "codex-cli" || entry.agentType == "codex-app") && entry.sessionId == "codex:otel-active") {
        return raw in lowSignalRawSet
    }
    // OpenClaw session.tool placeholder rows. The macOS daemon producer
    // (OpenClawAdapter.swift, 2026-05-18) drops new placeholders at source
    // when name + input + output are all absent, but earlier entries
    // persisted to timeline.json (or replayed from a daemon that doesn't
    // run the new guard) still leak through with raw=`tool · running`
    // etc. Structural match (`raw == "tool"` or starts with `"tool · "`)
    // so any status is covered — Gateway's SessionToolPayload.status is
    // free-form (running/complete/pending/error/failed/aborted/...).
    // Codex stop-time review 2026-05-18 (third round) flagged `failed`
    // slipping past the enumerated set.
    if (entry.agentType == "openclaw") {
        return raw == "tool" || raw.startsWith("tool · ")
    }
    return false
}

internal fun isOpenClawLowSignalResponse(entry: TimelineEntry): Boolean {
    if (entry.agentType != "openclaw") return false
    val isResponse = entry.type == "chat_response" || entry.type == "model_response"
    val isAutomatedStart = entry.type == "chat_start" && entry.automated == true
    if (!isResponse && !isAutomatedStart) return false

    val text = listOfNotNull(entry.summary, entry.detail).joinToString("\n").trim()
    if (text.isEmpty()) return false
    if (hasOpenClawNotificationFailureSignal(text)) return false

    val lower = text.lowercase()
    val hasNoReply = Regex("""\bno_reply\b""").containsMatchIn(lower)
    val looksLikePolling =
        Regex("""still translating""").containsMatchIn(lower) ||
        Regex("""translation still in progress""").containsMatchIn(lower) ||
        Regex("""not all .*?(terminal|published|failed|complete|completed)""").containsMatchIn(lower) ||
        Regex("""(in progress|still active|no action needed|nothing to notify yet)""").containsMatchIn(lower) ||
        Regex("""cron job (stays|retained|active)""").containsMatchIn(lower) ||
        Regex("""pipeline still active""").containsMatchIn(lower) ||
        Regex("""(아직|여전히|계속).*(번역|진행)\s*중""").containsMatchIn(text) ||
        Regex("""알릴 필요 없음|수행할 작업이 없음|대기합니다""").containsMatchIn(text)

    if (isAutomatedStart) return looksLikePolling
    return looksLikePolling &&
        (hasNoReply || lower.contains("no action needed") || lower.contains("nothing to notify yet") || text.contains("알릴 필요 없음"))
}

private fun hasOpenClawNotificationFailureSignal(text: String): Boolean {
    val english =
        Regex("""\b(line|notification|userid|target id|target issue)\b""", RegexOption.IGNORE_CASE).containsMatchIn(text) &&
            Regex("""\b(fail(ed|ure)?|missing|unconfigured|notified|needed|pending)\b""", RegexOption.IGNORE_CASE).containsMatchIn(text)
    val korean =
        Regex("""(LINE|알림|userId|사용자 ID|대상 ID).*(실패|미등록|미설정|구성되지|필요|대기)""", RegexOption.IGNORE_CASE).containsMatchIn(text)
    return english || korean
}

internal fun normalizeTimelineEntryForStorage(entry: TimelineEntry): TimelineEntry? {
    if (isLowSignalEntry(entry)) return null
    if (entry.agentType == "openclaw" &&
        entry.type == "model_call" &&
        (entry.automated == true || isOpenClawCronPrompt(entry.summary) || isOpenClawCronPrompt(entry.detail)) &&
        (isOpenClawCronPrompt(entry.summary) || isOpenClawCronPrompt(entry.detail))
    ) {
        val source = if (isOpenClawCronPrompt(entry.summary)) entry.summary else entry.detail
        return entry.copy(
            summary = summarizeOpenClawCronPrompt(source),
            detail = null,
            automated = true,
            summaryKind = entry.summaryKind ?: "heuristic",
        )
    }
    return entry
}

private fun isOpenClawCronPrompt(text: String?): Boolean =
    text?.trimStart()?.startsWith("[cron:") == true

private fun summarizeOpenClawCronPrompt(text: String?): String {
    if (text == null) return "자동 작업"
    val match = Regex("""^\[cron:[^\s\]]+\s+([^\]]+)\]""").find(text.trimStart())
    val job = match?.groupValues?.getOrNull(1)
        ?.replace(Regex("""[-_]+"""), " ")
        ?.replace(Regex("""\s+"""), " ")
        ?.trim()
        .orEmpty()
    if (job.isEmpty()) return "자동 작업"
    val capped = if (job.length > 64) job.take(61) + "..." else job
    return "자동 작업 · $capped"
}

/**
 * Mirror of `DaemonTimelineStore.detailHasRealSignal` (Swift). Detail
 * counts as real signal when it contains at least one non-empty line
 * that is not just a `status: ...` ack — i.e. there's an `input:` /
 * `output:` line (OpenClaw producer format) or any other content
 * worth surfacing.
 */
internal fun detailHasRealSignal(detail: String?): Boolean {
    if (detail == null) return false
    for (line in detail.lineSequence()) {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) continue
        if (!trimmed.lowercase().startsWith("status:")) return true
    }
    return false
}

private val lowSignalTypes = setOf("tool_exec", "tool_request", "tool_resolved")
private val lowSignalRawSet = setOf(
    "tool",
    "tool completed",
    "unknown",
    "unknown completed",
    "exec",
    "exec completed",
)
// OpenClaw uses a structural check inside `isLowSignalEntry` (raw == "tool"
// or starts with "tool · "), so no enumerated set is needed — Gateway's
// SessionToolPayload.status is free-form and any status suffix counts as
// placeholder when paired with the literal "tool" name fallback.

fun isTimelineCompletionEntry(entry: TimelineEntry): Boolean =
    entry.type == "chat_response" || entry.type == "chat_end" || entry.type == "model_response"

internal fun isProgressChatResponse(entry: TimelineEntry): Boolean {
    if (entry.type != "chat_response") return false
    if (entry.summaryKind == "progress") return true
    return looksLikeAssistantProgressUpdate(entry.detail ?: entry.summary)
}

private fun looksLikeAssistantProgressUpdate(text: String?): Boolean {
    val trimmed = text?.trim().orEmpty()
    if (trimmed.isEmpty()) return false
    val head = trimmed.take(800)
    val lower = head.lowercase()

    val englishProgress =
        Regex("""\b(still|currently|continues? to|is|are)\s+(running|building|installing|executing|processing|waiting)\b""").containsMatchIn(lower) ||
        Regex("""\b(still running|still building|build is running|is still running|are still running)\b""").containsMatchIn(lower) ||
        Regex("""\b(waiting for|wait until|once (?:the )?.*(?:finishes|completes|arrives)|continue once|will continue once|i.ll continue once)\b""").containsMatchIn(lower) ||
        Regex("""\b(no interim lines|buffers? output until completion|tail buffers output)\b""").containsMatchIn(lower)

    val koreanProgress =
        Regex("""(아직|계속)\s*(실행|진행|빌드|설치)\s*중""").containsMatchIn(head) ||
        Regex("""(완료|끝나|도착)면\s*(계속|이어)""").containsMatchIn(head) ||
        Regex("""(기다리는 중|대기 중)""").containsMatchIn(head)

    if (!englishProgress && !koreanProgress) return false

    val startsAsFinal =
        Regex("""^(done|completed|complete|fixed|merged|verified|all done)\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) ||
        Regex("""^(완료|수정 완료|검증 완료|반영 완료|머지 완료)""").containsMatchIn(trimmed)
    return !startsAsFinal
}

fun sameTimelineContext(a: TimelineEntry, b: TimelineEntry): Boolean {
    // 1) taskId — strongest grouping key; same task is same context.
    val aTask = a.taskId?.takeIf { it.isNotBlank() }
    val bTask = b.taskId?.takeIf { it.isNotBlank() }
    if (aTask != null && bTask != null) return aTask == bTask

    // 2) runId — adapter-emitted generation id.
    val aRunId = a.runId?.takeIf { it.isNotBlank() }
    val bRunId = b.runId?.takeIf { it.isNotBlank() }
    if (aRunId != null && bRunId != null) return aRunId == bRunId

    // 3) sessionId — once either side has one, both must match. The earlier
    // (projectName, agentType) fallback collapsed two real sessions in the
    // same project into one timeline row.
    val aSessionId = a.sessionId?.takeIf { it.isNotBlank() }
    val bSessionId = b.sessionId?.takeIf { it.isNotBlank() }
    if (aSessionId != null || bSessionId != null) {
        return aSessionId != null && bSessionId != null && aSessionId == bSessionId
    }

    // 4) Both sessionless — fallback for legacy entries.
    if (a.projectName.hasText() && a.projectName == b.projectName && a.agentType == b.agentType) return true
    return !a.projectName.hasText() && !b.projectName.hasText() && a.agentType == b.agentType
}

/**
 * Session-scoped timeline filter, driven by `state.focusedSessionId`. Mirrors
 * Swift `TimelineStripView.TimelineSessionFilter` + `matchesTimelineFilter` so
 * tapping a session on the tablet narrows the timeline to that session — the
 * per-session filter the Android strip previously lacked (client-render
 * divergence, 2026-07-13).
 */
data class TimelineSessionFilter(
    val sessionId: String,
    val projectName: String? = null,
    val agentType: String? = null,
) {
    /** Human label for the header pill: project name if present, else a
     *  friendly agent name, else the raw session id. */
    val label: String
        get() {
            if (!projectName.isNullOrEmpty()) return projectName
            return when (agentType) {
                "openclaw" -> "OpenClaw"
                "claude-code" -> "Claude"
                "codex-cli" -> "Codex CLI"
                "codex-app" -> "Codex App"
                "opencode" -> "OpenCode"
                "antigravity" -> "Antigravity"
                else -> sessionId
            }
        }
}

/** Canonical session id shared by session-list filters and timeline rows.
 * Observed sessions carry a provider prefix in `sessions_list`, while hook
 * timeline entries use the raw id. Mirrors Swift
 * `canonicalTimelineSessionId` and Node `getHistoryForSession`. */
fun canonicalTimelineSessionId(value: String?): String? {
    val trimmed = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val prefixes = listOf(
        "observed:claude:",
        "observed:codex:",
        "observed:codex-app:",
        "observed:opencode:",
        "observed:antigravity:",
    )
    val prefix = prefixes.firstOrNull { trimmed.startsWith(it) } ?: return trimmed
    return trimmed.removePrefix(prefix).trim().takeIf { it.isNotEmpty() }
}

/** True when this entry belongs to [filter]'s session. Matches by sessionId,
 *  the virtual `openclaw-gateway` session (sessionless OpenClaw rows), or the
 *  (projectName, agentType) fallback for legacy sessionless entries. Mirrors
 *  Swift `TimelineEntry.matchesTimelineFilter`. */
fun TimelineEntry.matchesTimelineFilter(filter: TimelineSessionFilter): Boolean {
    val sid = canonicalTimelineSessionId(sessionId)
    val focusedSid = canonicalTimelineSessionId(filter.sessionId)
    if (sid != null && sid == focusedSid) return true
    // OpenClaw entries are daemon-local and historically used agent
    // attribution without a session id — keep them visible when the virtual
    // Gateway session is focused.
    if (filter.sessionId == "openclaw-gateway" && agentType == "openclaw" && sid == null) return true
    if (sid != null) return false
    if (!filter.projectName.isNullOrEmpty() &&
        filter.projectName == projectName &&
        filter.agentType == agentType
    ) {
        return true
    }
    return false
}

fun pairedTimelineStart(entry: TimelineEntry, entries: List<TimelineEntry>): TimelineEntry? =
    entries.lastOrNull { candidate ->
        candidate.type == "chat_start" &&
            candidate.timestamp <= entry.timestamp &&
            entry.timestamp - candidate.timestamp <= 12 * 60 * 60 * 1000L &&
            sameTimelineContext(candidate, entry)
    }

fun timelineLifecycleBounds(entry: TimelineEntry, entries: List<TimelineEntry>): Pair<Long?, Long?> {
    val startedAt = entry.startedAt ?: pairedTimelineStart(entry, entries)?.timestamp
    val endedAt = entry.endedAt ?: if (isTimelineCompletionEntry(entry) || entry.type == "eval_result") {
        entry.timestamp
    } else {
        null
    }
    return startedAt to endedAt
}

private fun hasLaterCompletion(start: TimelineEntry, groups: List<GroupedEntry>): Boolean =
    groups.any { other ->
        isTimelineCompletionEntry(other.entry) &&
            other.entry.timestamp >= start.timestamp &&
            sameTimelineContext(start, other.entry)
    }

/**
 * The shared assistant reply that answered a queued / superseded chat_start.
 * The user submitted this prompt, but a later same-session prompt took over the
 * turn anchor before any completion arrived — Codex (and other observed agents)
 * coalesce rapid-fire prompts into one turn and emit a single Stop stamped to
 * the latest open turn (see `sameTurnAnchor`). The one shared response therefore
 * merges into that later turn, leaving this one with no reply of its own.
 * Returns the borrowed reply entry so the folded row can point at / show it;
 * null when this turn was answered on its own or is still the live open turn
 * (nothing has answered the batch yet). Mirrors Apple `timelineSupersedingGroup`.
 */
fun timelineSupersededSharedResponse(
    start: TimelineEntry,
    hasOwnResponse: Boolean,
    siblings: List<TimelineEntry>,
): TimelineEntry? {
    if (start.type != "chat_start" || hasOwnResponse) return null
    val later = siblings
        .filter { it.timestamp > start.timestamp && sameTimelineContext(start, it) }
        .sortedBy { it.timestamp }
    for (row in later) {
        when {
            // A same-session session boundary between the two prompts means this
            // turn closed on its own boundary — orphaned, not folded.
            row.type == "task_end" -> return null
            row.type == "chat_start" -> {
                // This later prompt owns the shared reply iff a same-session
                // completion anchors to it (child.startedAt == its timestamp).
                val reply = later.firstOrNull {
                    it.type == "chat_response" && it.timestamp >= row.timestamp &&
                        queuedTurnAnchor(row, it)
                } ?: later.firstOrNull {
                    isTimelineCompletionEntry(it) && it.timestamp >= row.timestamp &&
                        queuedTurnAnchor(row, it)
                }
                if (reply != null) return reply
                // else another still-open queued prompt — keep looking.
            }
            isTimelineCompletionEntry(row) -> return null
        }
    }
    return null
}

/**
 * Mirror of [timelineSupersededSharedResponse]: true when this answered
 * chat_start absorbed an earlier same-session queued prompt's shared reply.
 * Drives the small "shared" tag on the response sub-line. Mirrors Apple
 * `timelineAbsorbsQueuedPrompt`.
 */
fun timelineAbsorbsQueuedPrompt(
    start: TimelineEntry,
    hasOwnResponse: Boolean,
    siblings: List<TimelineEntry>,
): Boolean {
    if (start.type != "chat_start" || !hasOwnResponse) return false
    val earlier = siblings
        .filter { it.timestamp < start.timestamp && sameTimelineContext(start, it) }
        .sortedByDescending { it.timestamp }
    for (row in earlier) {
        when {
            row.type == "task_end" -> return false
            row.type == "chat_start" ->
                // Nearest prior same-session prompt folds into us iff it has no
                // completion of its own.
                return siblings.none {
                    isTimelineCompletionEntry(it) && sameTimelineContext(row, it) &&
                        queuedTurnAnchor(row, it)
                }
            isTimelineCompletionEntry(row) -> return false
        }
    }
    return false
}

/** `child.startedAt == start.timestamp` (or true when legacy emitters omit
 *  startedAt). Mirrors the private `sameTurnAnchor` in TimelineStore.kt. */
private fun queuedTurnAnchor(start: TimelineEntry, child: TimelineEntry): Boolean {
    val anchor = child.startedAt ?: return true
    return anchor == start.timestamp
}

private fun hasPairedChatResponse(end: TimelineEntry, groups: List<GroupedEntry>): Boolean =
    groups.any { other ->
        if (other.entry.type != "chat_response") return@any false
        if (!sameTimelineContext(end, other.entry)) return@any false
        val endStartedAt = end.startedAt
        val responseStartedAt = other.entry.startedAt
        if (endStartedAt != null && responseStartedAt != null) {
            kotlin.math.abs(endStartedAt - responseStartedAt) < 1000L
        } else {
            kotlin.math.abs(end.timestamp - other.entry.timestamp) <= 10_000L
        }
    }

private fun hasPairedChatStart(end: TimelineEntry, groups: List<GroupedEntry>): Boolean =
    groups.any { other ->
        val start = other.entry
        if (start.type != "chat_start") return@any false
        if (!sameTimelineContext(start, end)) return@any false
        val endStartedAt = end.startedAt
        if (endStartedAt != null) {
            kotlin.math.abs(endStartedAt - start.timestamp) < 1000L
        } else {
            start.timestamp <= end.timestamp &&
                end.timestamp - start.timestamp <= 12 * 60 * 60 * 1000L
        }
    }

private fun String?.hasText(): Boolean = !isNullOrBlank()
