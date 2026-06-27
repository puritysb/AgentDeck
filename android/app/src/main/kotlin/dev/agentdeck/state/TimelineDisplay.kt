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
            entry.type == "task_start" || entry.type == "task_end" -> shouldShowTaskMarker(entry)
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
private fun isMeaningfulChatStart(entry: TimelineEntry): Boolean {
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

internal fun shouldShowTaskMarker(entry: TimelineEntry): Boolean {
    if (entry.type != "task_start" && entry.type != "task_end") return true
    if (entry.taskCategory == "_empty") return false
    // session_end is an internal sample boundary, not a user activity. Some
    // sessions use the handoff command and some do not, so showing it as a
    // standalone TASK END row makes the visible timeline depend on workflow
    // hygiene rather than actual work.
    if (entry.type == "task_end" && entry.boundarySignal == "session_end") return false
    if (entry.type == "task_end") return true
    if (isMeaningfulTaskTitle(entry.summary)) return true
    return entry.taskScore != null ||
        !entry.taskOutcome.isNullOrBlank() ||
        !entry.taskCategory.isNullOrBlank() ||
        !entry.taskSummary.isNullOrBlank()
}

private fun isMeaningfulTaskTitle(raw: String): Boolean {
    val title = raw.trim()
    if (title.isEmpty()) return false
    if (Regex("""^task\s+\d+$""", RegexOption.IGNORE_CASE).matches(title)) return false
    if (Regex("""^작업\s*\d+$""").matches(title)) return false
    return true
}

/**
 * Codex OTel low-signal entries — `codex:otel-active` session emits raw
 * "tool" / "exec" / "unknown" markers that have no user value next to the
 * adapter-generated rich rows. Mirrors `timelineIsLowSignalEntry` in
 * apple/AgentDeck/UI/Monitor/TimelineStripView.swift.
 *
 * Visible at package level so `TimelineStore` can drop these on the
 * **add** path too — Apple filters at storage AND display, so legacy
 * persisted entries never come back when timeline.json replays. Android
 * doesn't persist (in-memory store only) but the same guard keeps the
 * 500-entry buffer from aging out useful rows behind OTel noise.
 */
internal fun isLowSignalEntry(entry: TimelineEntry): Boolean {
    if (entry.type !in lowSignalTypes) return false
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
