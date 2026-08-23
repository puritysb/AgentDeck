package dev.agentdeck.ui.timeline

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Sync
import androidx.compose.ui.graphics.vector.ImageVector
import dev.agentdeck.state.TimelineEntry

/**
 * Semantic icon key for a timeline entry. Mirrors `shared/src/timeline-icons.ts`
 * (`TimelineIconKey`) and `apple/AgentDeck/UI/Monitor/TimelineStripView.swift`
 * (`TimelineIconKey`). Single source of truth for the abstract semantics.
 *
 * Each platform maps the key to its native form. On Android tablet we use
 * Material Icons (vector). On Android e-ink we use ASCII bracket markers
 * (see [einkGlyph]) — Material vector glyphs render at thin strokes after
 * 1-bit dither and ghost on partial refresh.
 */
enum class TimelineIconKey {
    Success, Error, Running, Awaiting, Tool, Model, User, Task, Scheduled, Memory;

    /** Material Icon for tablet/full-color surfaces. */
    val materialIcon: ImageVector
        get() = when (this) {
            Success -> Icons.Filled.CheckCircle
            Error -> Icons.Filled.Error
            Running -> Icons.Filled.Sync
            Awaiting -> Icons.Filled.HourglassTop
            Tool -> Icons.Filled.Build
            Model -> Icons.Filled.Psychology
            User -> Icons.Filled.Person
            Task -> Icons.Filled.Checklist
            Scheduled -> Icons.Filled.Alarm
            Memory -> Icons.Filled.Memory
        }

    /** ASCII bracket glyph for e-ink displays. Constant 4-char width for
     *  monospace alignment; high black coverage so the panel doesn't ghost. */
    val einkGlyph: String
        get() = when (this) {
            Success -> "[OK]"
            Error -> "[!!]"
            Running -> "[..]"
            Awaiting -> "[??]"
            Tool -> "[T ]"
            Model -> "[M ]"
            User -> "[U ]"
            Task -> "[==]"
            Scheduled -> "[S ]"
            Memory -> "[~ ]"
        }
}

/**
 * Resolve the icon key for a timeline entry by type + status.
 * Mirrors `timelineIconKey()` in shared/src/timeline-icons.ts.
 */
fun timelineIconKey(type: String, status: String? = null): TimelineIconKey = when (type) {
    "task_start", "task_end" -> TimelineIconKey.Task
    "task_milestone" -> TimelineIconKey.Success
    "chat_start" -> TimelineIconKey.Running
    "chat_end", "chat_response", "model_response" -> TimelineIconKey.Success
    "model_call" -> TimelineIconKey.Model
    // `abandoned` shares the amber no-decision icon with `pending`: they are the
    // same fact at two points in time (still open / closed unanswered) and
    // neither is a refusal.
    "tool_request" -> when (status) {
        "approved" -> TimelineIconKey.Success
        "denied" -> TimelineIconKey.Error
        else -> TimelineIconKey.Awaiting
    }
    // The resolution row carries the SAME status as the request it closes, so it
    // must branch on it. Returning Success unconditionally drew a green check on
    // a denial and on an abandonment alike.
    "tool_resolved" -> when (status) {
        "denied" -> TimelineIconKey.Error
        "abandoned" -> TimelineIconKey.Awaiting
        else -> TimelineIconKey.Success
    }
    "tool_exec" -> TimelineIconKey.Tool
    "error" -> TimelineIconKey.Error
    "user_action" -> TimelineIconKey.User
    "scheduled" -> TimelineIconKey.Scheduled
    "memory_recall" -> TimelineIconKey.Memory
    "eval_result" -> if (status == "denied") TimelineIconKey.Error else TimelineIconKey.Success
    else -> TimelineIconKey.Running
}

/** Whether this entry type carries detail-pane body content (not a hierarchy marker). */
fun entryHasDetailBody(type: String): Boolean =
    type != "task_start" && type != "task_end" && type != "task_milestone"

/**
 * Staleness cap for the in-flight task spinner: a `task_start` older than
 * this without a matching `task_end` is treated as resolved-but-orphaned.
 * Mirrors `IN_FLIGHT_TASK_MAX_AGE_MS` in shared/src/timeline-icons.ts and
 * Apple `inFlightTaskMaxAgeSec` — without it, tablet task rows spun forever
 * on orphaned tasks that macOS already rendered as completed.
 */
const val IN_FLIGHT_TASK_MAX_AGE_MS = 10 * 60 * 1000L

/**
 * True when [entry] is a `task_start` whose matching `task_end` (same
 * `taskId`) hasn't yet appeared in [siblings] and the row is younger than
 * [IN_FLIGHT_TASK_MAX_AGE_MS]. Mirrors `isInFlightTask` in
 * shared/src/timeline-icons.ts — used to spin the leading icon for in-flight
 * task hierarchy markers instead of the static `task` glyph.
 */
fun isInFlightTask(
    entry: TimelineEntry,
    siblings: List<TimelineEntry>,
    nowMs: Long = System.currentTimeMillis(),
): Boolean {
    if (entry.type != "task_start") return false
    val taskId = entry.taskId ?: return false
    if (taskId.isEmpty()) return false
    for (s in siblings) {
        if (s.type == "task_end" && s.taskId == taskId) return false
    }
    if (nowMs - entry.timestamp > IN_FLIGHT_TASK_MAX_AGE_MS) return false
    return true
}

/**
 * Age cap for the rotating "running" treatment on turn rows. Turn-completion
 * signals are best-effort (Stop hook, transcript tail, PTY marker) and can be
 * lost across daemon handoffs — a chat_start older than this stops spinning
 * even without an explicit completion. Mirrors ROTATING_ENTRY_MAX_AGE_MS in
 * shared/src/timeline-icons.ts and `chatStartMaxAgeSec` on Apple.
 */
const val ROTATING_ENTRY_MAX_AGE_MS = 10 * 60 * 1000L

/** Same-session test mirroring the turn-merge rule: both ids equal, or both
 *  absent (legacy single-session emitters). */
private fun sameRotatingSession(a: String?, b: String?): Boolean =
    if (a.isNullOrEmpty() && b.isNullOrEmpty()) true
    else !a.isNullOrEmpty() && !b.isNullOrEmpty() && a == b

/**
 * True when a turn row should rotate its leading icon. Combines the
 * `Running` icon-key (chat_start, unknown types) with the in-flight task
 * hierarchy signal so an open `task_start` also spins until its `task_end`
 * arrives. Mirrors `isRotatingEntry` in shared/src/timeline-icons.ts.
 *
 * A chat_start only spins while its turn is plausibly still open:
 *   - no later same-session completion (chat_response/chat_end/model_response),
 *   - no later same-session chat_start (a new prompt supersedes the turn even
 *     when its completion signal was lost — Stop hooks are best-effort),
 *   - younger than [ROTATING_ENTRY_MAX_AGE_MS].
 */
/**
 * True when a later same-session completion row exists for this chat_start —
 * lets an *unmerged* turn row (its response didn't fold in, e.g. absorbed
 * elsewhere or filtered) still swap to the completed glyph instead of
 * presenting a finished turn as running.
 */
fun turnHasLaterCompletion(entry: TimelineEntry, siblings: List<TimelineEntry>): Boolean {
    if (entry.type != "chat_start") return false
    for (s in siblings) {
        if (s.timestamp < entry.timestamp) continue
        if (!sameRotatingSession(entry.sessionId, s.sessionId)) continue
        // `error` closes a turn as surely as a response does (mirrors Swift/TS).
        if (s.type == "chat_response" || s.type == "chat_end" ||
            s.type == "model_response" || s.type == "error") return true
    }
    return false
}

fun isRotatingEntry(
    entry: TimelineEntry,
    siblings: List<TimelineEntry>,
    nowMs: Long = System.currentTimeMillis(),
): Boolean {
    if (timelineIconKey(entry.type, entry.status) == TimelineIconKey.Running) {
        if (entry.type != "chat_start") return true
        val ts = entry.timestamp
        if (nowMs - ts > ROTATING_ENTRY_MAX_AGE_MS) return false
        for (s in siblings) {
            if (s.timestamp < ts) continue
            if (!sameRotatingSession(entry.sessionId, s.sessionId)) continue
            if (s.type == "chat_response" || s.type == "chat_end" || s.type == "model_response") return false
            if (s.type == "chat_start" && s.timestamp > ts) return false
        }
        return true
    }
    return isInFlightTask(entry, siblings, nowMs)
}
