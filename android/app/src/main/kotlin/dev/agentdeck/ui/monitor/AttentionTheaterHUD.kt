package dev.agentdeck.ui.monitor

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PromptOption
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.BrandIcon

/**
 * Floating attention card surfaced over the terrarium when any session is
 * awaiting input. Renders whatever `PromptOption[]` the bridge currently
 * emits — ≤3 short options stay in a horizontal row (the classic
 * yes/no/always look), everything else spills into a vertical scroll list
 * so plan approvals and OpenClaw scope selectors can show the full label
 * text instead of being truncated to three generic buttons.
 *
 * E-ink devices never reach this card: `MainActivity` composes
 * `EinkMonitorScreen` instead of the tablet tree whenever
 * `DeviceProfile.isEink`, so the suppression is structural rather than a
 * per-call-site check. Interactive popups don't work well on slow-refresh
 * screens — those users get the "?" creature indicator instead.
 *
 * `onRespond(index)` dispatches `select_option(index)` via
 * `BridgeConnection` — same path used by D200H hardware buttons.
 */
@Composable
fun AttentionTheaterHUD(
    featured: AttentionFeatured,
    queuedCount: Int,
    onRespond: (Int) -> Unit,
    onFocus: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val infinite = rememberInfiniteTransition(label = "attention")
    val breathe by infinite.animateFloat(
        initialValue = 1f,
        targetValue = 1.04f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "breathe",
    )
    val auraAlpha by infinite.animateFloat(
        initialValue = 0.12f,
        targetValue = 0.35f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1200, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "aura",
    )

    val effectiveOptions = effectiveOptions(featured.options)
    val useHorizontal = useHorizontalLayout(effectiveOptions, featured.promptType)

    Column(
        modifier = modifier
            .widthIn(max = 460.dp)
            .background(
                color = Color.Black.copy(alpha = 0.65f),
                shape = RoundedCornerShape(12.dp),
            )
            .border(
                border = BorderStroke(1.dp, TerrariumColors.LEDAmber.copy(alpha = 0.45f)),
                shape = RoundedCornerShape(12.dp),
            )
            .clip(RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
            modifier = if (onFocus != null) Modifier.clickable(onClick = onFocus) else Modifier,
        ) {
            Box(
                modifier = Modifier
                    .size(50.dp)
                    .scale(breathe)
                    .background(
                        color = Color.Black.copy(alpha = 0.45f),
                        shape = RoundedCornerShape(12.dp),
                    )
                    .border(
                        border = BorderStroke(1.dp, TerrariumColors.LEDAmber.copy(alpha = auraAlpha + 0.15f)),
                        shape = RoundedCornerShape(12.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                BrandIcon(agentType = featured.agentType, isEink = false, size = 34.dp)
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "ATTENTION",
                        color = TerrariumColors.LEDAmber,
                        fontSize = 9.5.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                    if (queuedCount > 0) {
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "+$queuedCount queued",
                            color = TerrariumColors.HUDSubtext,
                            fontSize = 9.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
                Text(
                    text = featured.projectName ?: "Session",
                    color = TerrariumColors.HUDText,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = featured.subtitle,
                    color = TerrariumColors.HUDSubtext,
                    fontSize = 10.5.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val question = featured.question
                if (!question.isNullOrEmpty()) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = question,
                        color = TerrariumColors.HUDText,
                        fontSize = 12.sp,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        if (effectiveOptions.isEmpty()) {
            // No device-answerable choice (Notification-only attention, or a
            // prompt whose options couldn't be parsed) — point the user to the
            // terminal instead of showing dead buttons.
            Text(
                text = "↳ Respond in your terminal",
                color = TerrariumColors.HUDSubtext,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(top = 2.dp),
            )
        } else if (useHorizontal) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                effectiveOptions.forEachIndexed { listIndex, option ->
                    val idx = option.index ?: listIndex
                    TheaterButton(
                        label = option.label,
                        fill = horizontalFill(idx),
                        isCursor = featured.navigable && featured.cursorIndex == idx,
                        enabled = featured.actionable,
                        modifier = Modifier.weight(1f),
                        onClick = { onRespond(idx) },
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.heightIn(max = 260.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                contentPadding = PaddingValues(vertical = 2.dp),
            ) {
                itemsIndexed(effectiveOptions) { listIndex, option ->
                    val idx = option.index ?: listIndex
                    TheaterListRow(
                        option = option,
                        isCursor = featured.navigable && featured.cursorIndex == idx,
                        enabled = featured.actionable,
                        onClick = { onRespond(idx) },
                    )
                }
            }
        }
        if (effectiveOptions.isNotEmpty() && !featured.actionable) {
            Text(
                text = "↳ Choose in the terminal to continue",
                color = TerrariumColors.HUDSubtext,
                fontSize = 10.5.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/** The options to render — exactly what the bridge/daemon delivered. When
 *  empty the prompt isn't remotely answerable (a Notification-only attention
 *  signal, or a no-PTY session whose options couldn't be parsed), so the card
 *  shows a "respond in your terminal" hint instead of fabricating a
 *  yes/no/always trio whose taps would dispatch `select_option` to a session
 *  that can't act on it. Mirrors Apple `AttentionTheaterHUD.effectiveOptions`
 *  and the shared d200h-layout terminal-hint branch. */
private fun effectiveOptions(options: List<PromptOption>): List<PromptOption> = options

private fun useHorizontalLayout(options: List<PromptOption>, promptType: String?): Boolean {
    if (options.size > 3) return false
    if (promptType == "multi_select") return false
    val maxLen = options.maxOfOrNull { it.label.length } ?: 0
    return maxLen <= 14
}

private fun horizontalFill(index: Int): Color = when (index) {
    0 -> TerrariumColors.LEDGreen
    1 -> TerrariumColors.LEDRed
    2 -> TerrariumColors.TetraNeon
    else -> Color.White.copy(alpha = 0.85f)
}

private fun verticalFill(option: PromptOption): Color = when {
    option.recommended == true -> TerrariumColors.LEDGreen.copy(alpha = 0.9f)
    isDenyLabel(option.label) -> TerrariumColors.LEDRed.copy(alpha = 0.85f)
    else -> Color.White.copy(alpha = 0.85f)
}

private fun isDenyLabel(label: String): Boolean {
    val l = label.lowercase()
    return l.startsWith("no") || l.startsWith("deny") || l.contains("don't") || l.contains("don\u2019t")
}

/**
 * Small lookaside wrapper so `MonitorScreen` doesn't have to reach across
 * Android/iOS `SessionInfo` variants — we pull exactly what the theater
 * needs and format it upstream. `agentType`/`question`/etc. all carry the
 * same meaning as the Swift `AttentionTheaterHUD.session` fields.
 */
data class AttentionFeatured(
    val sessionId: String?,
    val projectName: String?,
    val agentType: String?,
    val modelName: String?,
    val question: String?,
    val subtitle: String,
    val options: List<PromptOption> = emptyList(),
    val promptType: String? = null,
    val cursorIndex: Int = 0,
    val navigable: Boolean = false,
    val actionable: Boolean = true,
)

@Composable
private fun TheaterButton(
    label: String,
    fill: Color,
    isCursor: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(40.dp)
            .background(color = fill, shape = RoundedCornerShape(8.dp))
            .border(
                border = BorderStroke(
                    width = 1.5.dp,
                    color = if (isCursor) Color.White.copy(alpha = 0.9f) else Color.Transparent,
                ),
                shape = RoundedCornerShape(8.dp),
            )
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = Color.Black.copy(alpha = 0.85f),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun TheaterListRow(
    option: PromptOption,
    isCursor: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val fill = verticalFill(option)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(color = fill, shape = RoundedCornerShape(8.dp))
            .border(
                border = BorderStroke(
                    width = 1.5.dp,
                    color = if (isCursor) Color.White.copy(alpha = 0.9f) else Color.Transparent,
                ),
                shape = RoundedCornerShape(8.dp),
            )
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (option.selected == true) {
                Text(
                    text = "✓",
                    color = Color.Black.copy(alpha = 0.85f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(
                text = option.label,
                color = Color.Black.copy(alpha = 0.85f),
                fontSize = 12.5.sp,
                fontWeight = if (option.recommended == true) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val shortcut = option.shortcut?.uppercase()
            if (!shortcut.isNullOrEmpty()) {
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = shortcut,
                    color = Color.Black.copy(alpha = 0.7f),
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

/**
 * Build the `AttentionFeatured` payload from a tablet SessionInfo + the
 * current DashboardState's prompt fields. Only the focused session has
 * live `options`/`question`/`cursorIndex`, so non-focused sessions
 * surface with an empty option set and the fallback yes/no/always trio
 * takes over in the card.
 */
fun buildAttentionFeatured(
    session: SessionInfo,
    question: String?,
    options: List<PromptOption> = emptyList(),
    promptType: String? = null,
    cursorIndex: Int = 0,
    navigable: Boolean = false,
): AttentionFeatured {
    val agentLabel = when (session.agentType) {
        "claude-code" -> "Claude"
        "codex-cli"   -> "Codex CLI"
        "codex-app"   -> "Codex App"
        "openclaw"    -> "OpenClaw"
        "opencode"    -> "OpenCode"
        "antigravity" -> "Antigravity"
        else          -> session.agentType?.replaceFirstChar { it.uppercaseChar() } ?: "Agent"
    }
    val parts = buildList {
        add(agentLabel)
        session.modelName?.let { add(shortenModel(it)) }
    }
    return AttentionFeatured(
        sessionId = session.id,
        projectName = session.projectName,
        agentType = session.agentType,
        modelName = session.modelName,
        question = question,
        subtitle = parts.joinToString(" · "),
        options = options,
        promptType = promptType,
        cursorIndex = cursorIndex,
        navigable = navigable,
        // Managed sessions always answer through their PTY. An observed one is
        // answerable only when the daemon says so — it may be able to type into
        // that session's terminal, or be holding its AskUserQuestion open to
        // answer with our choice. Reading controlMode alone got this wrong in
        // both directions: it refused answerable sessions on a CLI daemon, and
        // it would now refuse the ask-gate too. Absent flag ⇒ not actionable,
        // never a live-looking button that goes nowhere.
        actionable = session.controlMode != "observed" || session.liveAnswerable == true,
    )
}

/** Check whether an agent state corresponds to "awaiting user input". */
fun AgentState.isAwaiting(): Boolean = when (this) {
    AgentState.AWAITING_PERMISSION,
    AgentState.AWAITING_OPTION,
    AgentState.AWAITING_DIFF -> true
    else -> false
}

private fun shortenModel(name: String): String {
    var s = name
    for (prefix in listOf("claude-", "gpt-", "o1-", "o3-")) {
        if (s.startsWith(prefix)) s = s.removePrefix(prefix)
    }
    return s.replace(Regex("-\\d{8}$"), "")
}
