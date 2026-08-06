package dev.agentdeck.ui.eink

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PromptOption
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.renderer.einkColorEnabled

data class EinkAttentionFeatured(
    val sessionId: String,
    val projectName: String?,
    val agentType: String?,
    val modelName: String?,
    val question: String?,
    val options: List<PromptOption>,
    val promptType: String?,
    val cursorIndex: Int,
    val navigable: Boolean,
    val actionable: Boolean = true,
    val queuedCount: Int,
)

fun buildEinkAttentionFeatured(state: DashboardState): EinkAttentionFeatured? {
    val sessions = buildEinkAwaitingSessions(state)
    val focused = state.sessionId?.let { focusedId -> sessions.firstOrNull { it.id == focusedId } }
    val featured = focused ?: sessions.firstOrNull() ?: return null
    val isFocused = featured.id == state.sessionId

    return EinkAttentionFeatured(
        sessionId = featured.id,
        projectName = featured.projectName,
        agentType = featured.agentType,
        modelName = featured.modelName,
        question = featured.question ?: (if (isFocused) state.question else null),
        options = if (featured.controlMode == "observed") {
            featured.options.orEmpty()
        } else if (isFocused) {
            state.options
        } else {
            emptyList()
        },
        promptType = featured.promptType ?: (if (isFocused) state.promptType else null),
        cursorIndex = if (isFocused) state.cursorIndex ?: 0 else 0,
        navigable = featured.controlMode != "observed"
            && isFocused
            && (state.navigable ?: false),
        // Observed sessions are answerable only when the daemon says it can
        // deliver the answer — by typing into that session's terminal, or by
        // holding its AskUserQuestion open to resolve with our choice. Absent
        // flag ⇒ not actionable, never a button that silently goes nowhere.
        actionable = featured.controlMode != "observed" || featured.liveAnswerable == true,
        queuedCount = (sessions.size - 1).coerceAtLeast(0),
    )
}

/** Options to render — exactly what the bridge/daemon delivered. When empty the
 *  prompt isn't remotely answerable from this e-ink surface (Notification-only
 *  attention, or an observed gated prompt this panel can't resolve), so the panel
 *  shows a "respond in your terminal" hint rather than fabricating a
 *  yes/no/always trio whose taps dispatch `select_option` to nowhere. */
fun effectiveEinkAttentionOptions(options: List<PromptOption>): List<PromptOption> = options

@Composable
fun EinkAttentionPanel(
    featured: EinkAttentionFeatured,
    onFocusSession: (String) -> Unit,
    onSelectOption: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val options = effectiveEinkAttentionOptions(featured.options)
    val accent = if (einkColorEnabled) Color(0xFFBB7700) else Color.Black
    val label = agentLabel(featured.agentType)
    val subtitle = listOfNotNull(label, featured.modelName?.let { abbreviateModelName(it) })
        .joinToString(" / ")

    Surface(
        modifier = modifier.fillMaxSize(),
        shape = RoundedCornerShape(4.dp),
        color = MaterialTheme.colorScheme.background,
        border = BorderStroke(2.dp, accent),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onFocusSession(featured.sessionId) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandInline(featured.agentType)
                Spacer(modifier = Modifier.width(5.dp))
                Text(
                    text = "ATTENTION",
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    color = accent,
                )
                if (featured.queuedCount > 0) {
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "+${featured.queuedCount}",
                        fontSize = 12.sp,
                        lineHeight = 15.sp,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = featured.projectName ?: "Session",
                    fontSize = 15.sp,
                    lineHeight = 19.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = subtitle,
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            featured.question?.takeIf { it.isNotBlank() }?.let { question ->
                Text(
                    text = question,
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (options.isEmpty()) {
                Text(
                    text = "Respond in your terminal",
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                itemsIndexed(options) { listIndex, option ->
                    val index = option.index ?: listIndex
                    AttentionOptionRow(
                        option = option,
                        indexLabel = option.shortcut?.uppercase() ?: (index + 1).toString(),
                        selected = featured.navigable && featured.cursorIndex == index,
                        enabled = featured.actionable,
                        onClick = {
                            onFocusSession(featured.sessionId)
                            onSelectOption(index)
                        },
                    )
                }
            }
            if (options.isNotEmpty() && !featured.actionable) {
                Text(
                    text = "Choose in your terminal",
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun AttentionOptionRow(
    option: PromptOption,
    indexLabel: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = if (selected) Color.Black else Color.DarkGray,
                shape = RoundedCornerShape(4.dp),
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = indexLabel,
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(22.dp),
        )
        Text(
            text = option.label,
            fontSize = 14.sp,
            lineHeight = 18.sp,
            fontWeight = if (option.recommended == true || selected) FontWeight.Bold else FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun BrandInline(agentType: String?) {
    Text(
        text = agentIcon(agentType),
        fontSize = 12.sp,
        lineHeight = 12.sp,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurface,
    )
}

private fun buildEinkAwaitingSessions(state: DashboardState): List<SessionInfo> {
    val sessions = mutableListOf<SessionInfo>()
    val primaryAgentType = state.agentType
    if (
        state.agentState.isAwaitingInput() &&
        primaryAgentType != null &&
        primaryAgentType != "daemon" &&
        state.siblingSessions.none { it.agentType == primaryAgentType }
    ) {
        sessions += SessionInfo(
            id = state.sessionId ?: "primary",
            port = 0,
            projectName = state.projectName,
            agentType = primaryAgentType,
            alive = true,
            state = state.agentState.wireName(),
            modelName = state.modelName,
            effortLevel = state.effortLevel,
        )
    }

    sessions += state.siblingSessions
        .filter { mapSessionState(it).isAwaitingInput() }

    return sessions.sortedWith(::compareSessionsForDisplay)
}

private fun AgentState.isAwaitingInput(): Boolean = when (this) {
    AgentState.AWAITING_PERMISSION,
    AgentState.AWAITING_OPTION,
    AgentState.AWAITING_DIFF -> true
    else -> false
}

private fun AgentState.wireName(): String = when (this) {
    AgentState.AWAITING_PERMISSION -> "awaiting_permission"
    AgentState.AWAITING_OPTION -> "awaiting_option"
    AgentState.AWAITING_DIFF -> "awaiting_diff"
    AgentState.PROCESSING -> "processing"
    AgentState.IDLE -> "idle"
    AgentState.DISCONNECTED -> "disconnected"
}

private fun agentLabel(agentType: String?): String = when (agentType) {
    "claude-code" -> "Claude"
    "codex-cli" -> "Codex CLI"
    "codex-app" -> "Codex App"
    "openclaw" -> "OpenClaw"
    "opencode" -> "OpenCode"
    "antigravity" -> "Antigravity"
    null -> "Agent"
    else -> agentType.replaceFirstChar { it.uppercaseChar() }
}
