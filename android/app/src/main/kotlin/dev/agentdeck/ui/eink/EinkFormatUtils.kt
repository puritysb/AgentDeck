package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.renderer.einkColorEnabled

fun formatCount(n: Int): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "%.1fK".format(n / 1_000.0)
    else -> n.toString()
}

fun formatDuration(seconds: Int): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

fun formatDurationLong(millis: Long): String {
    val totalSec = (millis / 1000).toInt()
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return "%d:%02d:%02d".format(h, m, s)
}

fun stateMarker(state: AgentState): String = when (state) {
    AgentState.IDLE -> "\u25CF IDLE"                          // ●
    AgentState.PROCESSING -> "\u25C9 PROCESSING"              // ◉
    AgentState.AWAITING_PERMISSION -> "\u26A0 PERMISSION"     // ⚠
    AgentState.AWAITING_OPTION -> "\u25C7 SELECT"             // ◇
    AgentState.AWAITING_DIFF -> "\u25A1 DIFF REVIEW"          // □
    AgentState.DISCONNECTED -> "\u25CB DISCONNECTED"          // ○
}

fun compactStateMarker(state: AgentState): String = when (state) {
    AgentState.IDLE -> "\u25CF IDLE"
    AgentState.PROCESSING -> "\u25C9 PROC"
    AgentState.AWAITING_PERMISSION -> "\u26A0 PERM"
    AgentState.AWAITING_OPTION -> "\u25C7 SEL"
    AgentState.AWAITING_DIFF -> "\u25A1 DIFF"
    AgentState.DISCONNECTED -> "\u25CB OFF"
}

/** Color-coded state indicator for color e-ink. Returns null for B&W e-ink. */
fun stateColor(state: AgentState): Color? {
    if (!einkColorEnabled) return null
    return when (state) {
        AgentState.IDLE -> Color(0xFF227733)               // green
        AgentState.PROCESSING -> Color(0xFF335588)         // blue
        AgentState.AWAITING_PERMISSION -> Color(0xFFBB7700) // amber
        AgentState.AWAITING_OPTION -> Color(0xFFBB7700)    // amber
        AgentState.AWAITING_DIFF -> Color(0xFF775599)      // purple
        AgentState.DISCONNECTED -> Color(0xFFCC2222)       // red
    }
}

/** State priority for sorting: busiest first */
fun stateRank(state: AgentState): Int = when (state) {
    AgentState.PROCESSING -> 0
    AgentState.AWAITING_PERMISSION, AgentState.AWAITING_OPTION, AgentState.AWAITING_DIFF -> 1
    AgentState.IDLE -> 2
    AgentState.DISCONNECTED -> 3
}

fun agentTypeRank(agentType: String?): Int = when (agentType) {
    "openclaw" -> 0
    "claude-code" -> 1
    "codex-cli" -> 2
    "codex-app" -> 3
    "opencode" -> 4
    else -> 5
}

// OpenClaw / Gateway visibility SSOT — hand-mirrored from
// shared/src/session-utils.ts (isOpenClawSessionActive / hasOpenClawSession).
// "Active" = authenticated / can-route (gatewayConnected). Consumers must gate
// OpenClaw rendering on session PRESENCE, never re-derive from raw gateway
// flags — the daemon source is the single authority.
fun isOpenClawSessionActive(gatewayConnected: Boolean?): Boolean = gatewayConnected == true

fun hasOpenClawSession(sessions: List<SessionInfo>): Boolean =
    sessions.any { it.agentType == "openclaw" }

private val naturalChunks = Regex("\\d+|\\D+")

fun naturalLabelCompare(left: String?, right: String?): Int {
    val lhs = left.orEmpty()
    val rhs = right.orEmpty()
    val leftChunks = naturalChunks.findAll(lhs).map { it.value }.toList()
    val rightChunks = naturalChunks.findAll(rhs).map { it.value }.toList()
    val count = minOf(leftChunks.size, rightChunks.size)

    for (index in 0 until count) {
        val a = leftChunks[index]
        val b = rightChunks[index]
        val bothNumbers = a.all(Char::isDigit) && b.all(Char::isDigit)
        val diff = if (bothNumbers) {
            compareNumericChunks(a, b)
        } else {
            String.CASE_INSENSITIVE_ORDER.compare(a, b)
        }
        if (diff != 0) return diff
    }

    if (leftChunks.size != rightChunks.size) return leftChunks.size - rightChunks.size
    return String.CASE_INSENSITIVE_ORDER.compare(lhs, rhs)
}

private fun compareNumericChunks(left: String, right: String): Int {
    val lhs = left.trimStart('0').ifEmpty { "0" }
    val rhs = right.trimStart('0').ifEmpty { "0" }
    if (lhs.length != rhs.length) return lhs.length - rhs.length
    val valueDiff = lhs.compareTo(rhs)
    if (valueDiff != 0) return valueDiff
    return left.length - right.length
}

fun compareSessionsForDisplay(left: SessionInfo, right: SessionInfo): Int {
    val typeDiff = agentTypeRank(left.agentType) - agentTypeRank(right.agentType)
    if (typeDiff != 0) return typeDiff

    val nameDiff = naturalLabelCompare(left.projectName, right.projectName)
    if (nameDiff != 0) return nameDiff

    val leftStarted = left.startedAt
    val rightStarted = right.startedAt
    if (leftStarted != null && rightStarted != null) {
        val cmp = leftStarted.compareTo(rightStarted)
        if (cmp != 0) return cmp
        // identical timestamps fall through to the id tiebreak below
    } else if (leftStarted != null) {
        return -1
    } else if (rightStarted != null) {
        return 1
    }

    return naturalLabelCompare(left.id, right.id)
}

fun agentIcon(agentType: String?): String = when (agentType) {
    "claude-code" -> "\u273B"         // ✻ (Claude sparkle)
    "openclaw" -> "\uD83E\uDD9E"     // 🦞 (crayfish)
    "codex-cli" -> "\u276F"           // ❯ (terminal prompt)
    "codex-app" -> "\u276F"           // ❯ (Codex mark)
    "opencode" -> "\u25A3"            // ▣ (nested square)
    else -> "\u25CF"                   // ● bullet
}

fun mapSessionState(session: dev.agentdeck.net.SessionInfo): AgentState {
    if (!session.alive) return AgentState.DISCONNECTED
    // alive=true → never DISCONNECTED. The wire may carry "disconnected" for
    // sessions whose state machine has not yet transitioned (e.g. OpenClaw
    // gateway adapter alive but daemon stateMachine still in .disconnected
    // because the connect-time session_start hook only fires from
    // .disconnected and may have raced). Treat any non-active state as IDLE.
    return when (session.state) {
        "processing" -> AgentState.PROCESSING
        "awaiting_permission" -> AgentState.AWAITING_PERMISSION
        "awaiting_option" -> AgentState.AWAITING_OPTION
        "awaiting_diff" -> AgentState.AWAITING_DIFF
        else -> AgentState.IDLE
    }
}

/** Abbreviate model names for space-constrained e-ink display. */
fun abbreviateModelName(name: String): String {
    return name
        // Claude catalog full names → short form
        .replace("Claude Opus 4", "opus-4")
        .replace("Claude Sonnet 4", "sonnet-4")
        .replace("Claude Haiku 4.5", "haiku-4.5")
        .replace("Claude Haiku 3.5", "haiku-3.5")
        // Claude Code bridge modelName: "claude-opus-4-6" → "opus-4"
        .replace(Regex("claude-(opus|sonnet|haiku)-(\\d+)(?:-(\\d+))?(?:-\\d{8})?")) { m ->
            "${m.groupValues[1]}-${m.groupValues[2]}"
        }
        // DeepSeek
        .replace("DeepSeek: DeepSeek ", "DS:")
        .replace("DeepSeek ", "DS:")
        // Gemini
        .replace(Regex("Gemini (\\S+) Pro")) { "Gem ${it.groupValues[1]}P" }
        .replace(Regex("Gemini (\\S+) Flash")) { "Gem ${it.groupValues[1]}F" }
        .replace("Gemini ", "Gem ")
        // GPT
        .replace("gpt-4o-mini", "4o-mini")
        .replace("gpt-4o", "4o")
        .replace("gpt-4-turbo", "4-turbo")
}

fun antigravityDisplayLine(state: DashboardState): String? {
    val status = state.antigravityStatus ?: return null
    return status.planName?.replace("Google AI ", "")?.takeIf { it.isNotBlank() }
}

@Composable
fun EinkTextGauge(
    label: String,
    percent: Double,
    barLength: Int = 20,
) {
    val pct = percent.coerceIn(0.0, 100.0).toInt()
    val filled = (pct * barLength / 100).coerceAtMost(barLength)
    val empty = barLength - filled
    val bar = "\u2588".repeat(filled) + "\u2591".repeat(empty)  // █ and ░

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "$label:",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "[$bar] $pct%",
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
