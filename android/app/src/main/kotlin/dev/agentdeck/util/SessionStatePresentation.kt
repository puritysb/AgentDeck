// GENERATED from shared/src/session-state-presentation.ts and design/tokens.css bindings. DO NOT EDIT.
// Regenerate with `pnpm generate-session-state`.
package dev.agentdeck.util

import dev.agentdeck.net.AgentState

/** Session state presentation — DESIGN.md §2.7. Only [SessionTone.AWAITING] may animate. */
enum class SessionTone(val bright: Long, val paper: Long) {
    IDLE(0xFF9A9AA2, 0xFF4D4D51),
    WORKING(0xFF3ED6E8, 0xFF1F6B74),
    AWAITING(0xFFFFA93D, 0xFF7F541E),
    OFFLINE(0xFF7A8A9C, 0xFF3D454E);

    fun color(onPaper: Boolean = false): Long = if (onPaper) paper else bright
    val pulses: Boolean get() = this == AWAITING
}

/** [label] sentence case; [short] uppercase pill, at most 7 characters; [tiny] at most 4. */
data class SessionStateWords(val label: String, val short: String, val tiny: String)

val AgentState.sessionTone: SessionTone
    get() = when (this) {
        AgentState.DISCONNECTED -> SessionTone.OFFLINE
        AgentState.IDLE -> SessionTone.IDLE
        AgentState.PROCESSING -> SessionTone.WORKING
        AgentState.AWAITING_PERMISSION -> SessionTone.AWAITING
        AgentState.AWAITING_OPTION -> SessionTone.AWAITING
        AgentState.AWAITING_DIFF -> SessionTone.AWAITING
    }

val AgentState.sessionWords: SessionStateWords
    get() = when (this) {
        AgentState.DISCONNECTED -> SessionStateWords("Offline", "OFFLINE", "OFF")
        AgentState.IDLE -> SessionStateWords("Idle", "IDLE", "IDLE")
        AgentState.PROCESSING -> SessionStateWords("Working", "WORKING", "WORK")
        AgentState.AWAITING_PERMISSION -> SessionStateWords("Needs approval", "APPROVE", "PERM")
        AgentState.AWAITING_OPTION -> SessionStateWords("Needs a choice", "CHOOSE", "OPT")
        AgentState.AWAITING_DIFF -> SessionStateWords("Review diff", "REVIEW", "DIFF")
    }
