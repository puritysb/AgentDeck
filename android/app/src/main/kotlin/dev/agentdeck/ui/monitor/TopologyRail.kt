package dev.agentdeck.ui.monitor

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.CodexRateLimits
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.AgentDeckMark
import dev.agentdeck.ui.component.brandColorForAgent
import dev.agentdeck.util.DeviceProfileHolder
import dev.agentdeck.util.codexLimitRows
import dev.agentdeck.util.formatResetTime
import java.time.Instant

/**
 * Relationship-centric rail that replaces the former `TankStatusPanel`.
 * Reads top-to-bottom as:
 *
 *   UPSTREAM (Claude · OpenClaw · MLX · Ollama)
 *       │
 *   ⎔ AgentDeck :9120
 *       │
 *   DOWNSTREAM (this tablet)
 *
 * Each upstream provider row shows its status (LED glyph), label, compact
 * subtitle, optional inline rate-gauges (Claude's 5h/7d) and **consumer
 * creature dots** — the brand colors of sessions whose modelName maps to
 * this provider. "Who's using Claude right now" becomes visible at a
 * glance, which is the whole point of showing relationships instead of
 * two unrelated list boxes.
 *
 * Palette stays fully within `TerrariumColors` so the rail still reads as
 * aquarium HUD chrome, not a light-mode card. Mirrors the Swift
 * `TopologyRail.swift` contract.
 */
@Composable
fun TopologyRail(
    state: DashboardState,
    modifier: Modifier = Modifier,
    scale: MonitorLayoutScale = MonitorLayoutScale.phone,
) {
    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(scale.panelPadding),
        verticalArrangement = Arrangement.spacedBy(scale.topologyRowSpacing),
    ) {
        SectionHeader("UPSTREAM", scale)
        UpstreamRows(state = state, scale = scale)
        HubZone(state = state, scale = scale)
        SectionHeader("DOWNSTREAM", scale)
        DownstreamRows(scale = scale)
    }
}

// MARK: - Section chrome

@Composable
private fun SectionHeader(title: String, scale: MonitorLayoutScale = MonitorLayoutScale.phone) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.padding(bottom = 4.dp),
    ) {
        Text(
            text = title,
            color = TerrariumColors.HUDSubtext,
            fontSize = scale.fontHeader,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 1.4.sp,
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(0.5.dp)
                .background(TerrariumColors.TetraNeon.copy(alpha = 0.25f)),
        )
    }
}

@Composable
private fun HubZone(
    state: DashboardState,
    scale: MonitorLayoutScale,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = scale.topologySectionSpacing),
    ) {
        HubRow(state = state, scale = scale)
    }
}

@Composable
private fun HubRow(
    state: DashboardState,
    scale: MonitorLayoutScale,
) {
    val visual = hubVisualMode(state)
    val pulse by rememberInfiniteTransition(label = "hubPulse").animateFloat(
        initialValue = 0.22f,
        targetValue = 0.62f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1100, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "hubGlow",
    )
    val glowAlpha = if (visual == HubVisualMode.AWAITING) pulse else visual.glowAlpha
    val shape = RoundedCornerShape(7.dp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                val bleed = 1.5.dp.toPx()
                val corner = 9.dp.toPx()
                drawRoundRect(
                    color = visual.accent.copy(alpha = glowAlpha * 0.32f),
                    topLeft = Offset(-bleed, -bleed),
                    size = Size(size.width + bleed * 2f, size.height + bleed * 2f),
                    cornerRadius = CornerRadius(corner, corner),
                    style = Stroke(width = 7.dp.toPx()),
                )
            }
            .background(TerrariumColors.MidWater.copy(alpha = visual.fillAlpha), shape)
            .border(1.dp, visual.accent.copy(alpha = visual.borderAlpha), shape)
            .padding(horizontal = 6.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AgentDeckMark(size = 16.dp, color = visual.accent)
        Text(
            text = "AgentDeck",
            color = TerrariumColors.HUDText,
            fontSize = scale.fontHeader,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = ":${daemonPortText(state)}",
            color = TerrariumColors.HUDSubtext,
            fontSize = scale.fontSub,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.weight(1f))
    }
}

private enum class HubVisualMode(
    val accent: Color,
    val fillAlpha: Float,
    val borderAlpha: Float,
    val glowAlpha: Float,
) {
    OFFLINE(TerrariumColors.HUDSubtext.copy(alpha = 0.55f), 0.36f, 0.16f, 0.0f),
    LIVE(TerrariumColors.TetraNeon, 0.68f, 0.42f, 0.20f),
    ACTIVE(TerrariumColors.TetraNeon, 0.76f, 0.64f, 0.34f),
    AWAITING(TerrariumColors.LEDAmber, 0.78f, 0.78f, 0.62f),
}

private fun hubVisualMode(state: DashboardState): HubVisualMode {
    if (!state.bridgeConnected) return HubVisualMode.OFFLINE
    val siblingStates = state.siblingSessions.mapNotNull { it.state }
    val hasAwaiting = state.agentState.isAwaitingInput() ||
        siblingStates.any { it == "awaiting_permission" || it == "awaiting_option" || it == "awaiting_diff" }
    if (hasAwaiting) return HubVisualMode.AWAITING
    val hasProcessing = state.agentState == AgentState.PROCESSING ||
        siblingStates.any { it == "processing" }
    if (hasProcessing) return HubVisualMode.ACTIVE
    return HubVisualMode.LIVE
}

private fun AgentState.isAwaitingInput(): Boolean = when (this) {
    AgentState.AWAITING_PERMISSION,
    AgentState.AWAITING_OPTION,
    AgentState.AWAITING_DIFF -> true
    else -> false
}

private fun daemonPortText(state: DashboardState): String =
    state.remoteUrl
        ?.substringAfterLast(':', missingDelimiterValue = "")
        ?.takeIf { it.all(Char::isDigit) }
        ?: "9120"

// MARK: - Upstream rows

@Composable
private fun UpstreamRows(state: DashboardState, scale: MonitorLayoutScale) {
    val usage = state.usage
    val ollama = state.ollamaStatus
    val modelCatalog = state.modelCatalog ?: emptyList()
    // `modelCatalog` belongs to the primary session's provider only — if
    // the primary session is a Claude session, the catalog has Claude
    // models; if OpenClaw, it has OpenClaw gateway models. Mis-reading
    // this caused `claude-opus` to render under the OpenClaw row.
    // Conservative — only the two known catalog publishers get trusted.
    val catalogOwner: ProviderKey = when (state.agentType) {
        "claude-code" -> ProviderKey.CLAUDE
        "openclaw" -> ProviderKey.OPENCLAW
        else -> ProviderKey.UNKNOWN
    }

    Column(verticalArrangement = Arrangement.spacedBy(scale.providerRowSpacing)) {
        // Claude — subtitle carries the actually-available model catalog
        // (Opus / Sonnet / Haiku) only when the catalog belongs to
        // Claude. Otherwise we fall back to OAuth status or nil.
        val claudeModels = if (catalogOwner == ProviderKey.CLAUDE) {
            modelCatalog
                .filter { it.available }
                .sortedWith(
                    compareByDescending<ModelCatalogEntry> { it.role == "default" }
                        .thenBy { it.name }
                )
                .map { shortClaudeModel(it.name) }
        } else {
            emptyList()
        }
        val claudeConsumers = consumersFor(ProviderKey.CLAUDE, state)
        val claudeRateLimits = buildList {
            val isStale = usage.usageStale == true
            val fiveHour = usage.fiveHourPercent
            if (fiveHour != null) {
                add(
                    RateChip(
                        label = "5h",
                        percent = fiveHour,
                        reset = usage.fiveHourResetsAt?.let { formatResetTime(it) },
                        stale = isStale,
                    )
                )
            }
            val sevenDay = usage.sevenDayPercent
            if (sevenDay != null) {
                add(
                    RateChip(
                        label = "7d",
                        percent = sevenDay,
                        reset = usage.sevenDayResetsAt?.let { formatResetTime(it) },
                        stale = isStale,
                    )
                )
            }
        }
        val showClaudeRow = state.oauthConnected == true ||
            claudeModels.isNotEmpty() ||
            claudeConsumers.isNotEmpty() ||
            claudeRateLimits.isNotEmpty()
        if (showClaudeRow) {
            ProviderRow(
                name = "Claude",
                status = when (state.oauthConnected) {
                    true -> LEDStatus.OK
                    false -> LEDStatus.WARN
                    null -> LEDStatus.DIM
                },
                subtitle = when {
                    claudeModels.isNotEmpty() -> claudeModels.joinToString(", ")
                    state.oauthConnected == false -> "Not connected"
                    else -> null
                },
                consumers = claudeConsumers,
                rateLimits = claudeRateLimits,
            )
        }

        // Codex (ChatGPT) — Codex CLI writes a `rate_limits` snapshot (5h
        // primary / weekly secondary) into its own local rollout files, so
        // the daemon surfaces them here much like the Claude 5h/7d gauges.
        // Local-file data, no OpenAI API call. Subtitle carries the ChatGPT
        // plan label. Hidden when neither a plan nor limit data is present.
        val codexPlan = usage.codexPlanType?.takeIf { it.isNotBlank() }
        val codexRateLimits = buildCodexRateChips(state.codexRateLimits)
        if (state.codexRateLimits != null || codexPlan != null) {
            ProviderRow(
                name = "Codex",
                status = LEDStatus.OK,
                subtitle = codexSubtitle(codexPlan, state.codexRateLimits),
                consumers = consumersFor(ProviderKey.CODEX, state),
                rateLimits = codexRateLimits,
            )
        }

        val openClawVisible = (state.gatewayAvailable == true || state.gatewayConnected == true)
        if (openClawVisible) {
            // Only surface the catalog under OpenClaw when it actually
            // belongs to OpenClaw — same gate we apply to the Claude row.
            val openClawLines = if (catalogOwner == ProviderKey.OPENCLAW) {
                openClawDisplayLines(modelCatalog)
            } else {
                emptyList()
            }
            val subtitle = when {
                openClawLines.isNotEmpty() -> openClawLines.joinToString(", ")
                state.gatewayConnected != true -> "Not connected"
                else -> null
            }
            ProviderRow(
                name = "OpenClaw",
                status = when {
                    state.gatewayHasError == true -> LEDStatus.ERROR
                    // OK only when the Gateway is authenticated — reachability
                    // alone keeps the row amber so users know setup isn't
                    // finished (matches iOS topology semantics).
                    state.gatewayConnected == true -> LEDStatus.OK
                    else -> LEDStatus.WARN
                },
                subtitle = subtitle,
                consumers = consumersFor(ProviderKey.OPENCLAW, state),
                rateLimits = emptyList(),
            )
        }

        if (state.mlxModels.isNotEmpty()) {
            ProviderRow(
                name = "MLX",
                status = LEDStatus.OK,
                subtitle = state.mlxModels.joinToString(", "),
                consumers = consumersFor(ProviderKey.MLX, state),
                rateLimits = emptyList(),
            )
        }

        if (ollama != null) {
            // Prefer "running" models (VRAM-loaded) but fall back to the
            // full installed list so the row is never empty when Ollama is
            // installed but idle. Mirrors the iOS TopologyRail behavior.
            val running = ollama.models.filter { it.sizeVram > 0 }
            val source = if (running.isNotEmpty()) running else ollama.models
            val subtitle = when {
                source.isNotEmpty() -> source.joinToString(", ") { it.name }
                ollama.available -> "installed, no models loaded"
                else -> "stopped"
            }
            ProviderRow(
                name = "Ollama",
                status = if (ollama.available) LEDStatus.OK else LEDStatus.DIM,
                subtitle = subtitle,
                consumers = consumersFor(ProviderKey.OLLAMA, state),
                rateLimits = emptyList(),
            )
        }

        // Antigravity — surfaced whenever the bridge reports an active
        // plan. Hidden otherwise so the rail doesn't grow a pointless row
        // for users not on Google's product.
        val antiPlan = state.antigravityStatus?.planName?.takeIf { it.isNotBlank() }
        if (antiPlan != null) {
            // Plan name ONLY. Antigravity's real usage view (two per-group
            // 5h/weekly quotas) is fetched live from Google's backend and not
            // persisted locally; the local `availableCredits` value doesn't
            // match it, so we intentionally don't show a credit number. Mirrors iOS.
            ProviderRow(
                name = "Antigravity",
                status = LEDStatus.OK,
                subtitle = antiPlan,
                consumers = consumersFor(ProviderKey.ANTIGRAVITY, state),
                rateLimits = emptyList(),
            )
        }

        if (state.subscriptions.isNotEmpty()) {
            SubscriptionsFooter(state.subscriptions)
        }
    }
}

/**
 * Strip `claude-` prefix and ISO date suffix so the compact subtitle row
 * can fit 3+ model names horizontally. Mirrors the iOS helper with the
 * same name.
 */
private fun shortClaudeModel(name: String): String {
    var s = name
    if (s.startsWith("claude-")) s = s.removePrefix("claude-")
    s = s.replace(Regex("-\\d{8}$"), "")
    return s
}

/**
 * Pull display lines for the OpenClaw model catalog. The HUD upstream rail
 * (and the e-ink TANK STATUS panel) surfaces only the model marked primary
 * (`role == "default"`) so the row reads as "what OpenClaw is routing to
 * right now" instead of dumping the full catalog. If the user hasn't
 * tagged any model as default the list collapses to empty — promoting a
 * non-default entry would silently override the explicit primary-only
 * rule. Mirrors iOS `DashboardDataRules`.
 *
 * Names are normalised to strip provider duplication (`DeepSeek: DeepSeek X`
 * → `DeepSeek X`) so compact subtitles read cleanly.
 */
internal fun openClawDisplayLines(catalog: List<ModelCatalogEntry>): List<String> {
    val primary = catalog.firstOrNull { it.available && it.role == "default" } ?: return emptyList()
    return listOf(normalizeOpenClawName(primary.name))
}

internal fun normalizeOpenClawName(name: String): String =
    name
        .replace("DeepSeek: DeepSeek ", "DeepSeek ")
        .replace("DeepSeek:", "DeepSeek")
        .replace("GPT: GPT ", "GPT ")
        .replace("GLM: GLM ", "GLM ")
        .trim()

/**
 * Snapshot of the wall clock that re-emits every `periodMillis` so views
 * keyed on time invalidate without depending on incidental state changes.
 * Used by the SUBSCRIPTIONS footer (HUD rail) and the e-ink TANK STATUS
 * subscription line so a row can flip from a future date to
 * "renewal needed" the moment the underlying timestamp becomes past — a
 * dashboard left open across an expiry would otherwise hold the stale
 * date until the daemon next pushes a state update.
 *
 * 60s cadence keeps battery cost negligible while still landing the flip
 * within a minute of the actual expiry, which is more than fine for
 * subscription windows that span days.
 */
@Composable
internal fun rememberCurrentInstant(periodMillis: Long = 60_000L): State<Instant> =
    produceState(initialValue = Instant.now(), periodMillis) {
        while (true) {
            value = Instant.now()
            kotlinx.coroutines.delay(periodMillis)
        }
    }

@Composable
private fun SubscriptionsFooter(subs: List<SubscriptionInfo>) {
    // `rememberCurrentInstant` re-emits `now` every 60s and invalidates this
    // composable, so a subscription that expires while the dashboard is
    // open flips from its date suffix to "renewal needed" without needing
    // unrelated state to change first. Reading `Instant.now()` inline
    // would only refresh on incidental recomposition, which can be rare
    // when the daemon is idle.
    val now by rememberCurrentInstant()
    Column(
        verticalArrangement = Arrangement.spacedBy(1.dp),
        modifier = Modifier.padding(top = 4.dp),
    ) {
        Text(
            text = "SUBSCRIPTIONS",
            color = TerrariumColors.HUDSubtext.copy(alpha = 0.8f),
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 0.8.sp,
        )
        subs.forEach { sub ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = sub.name,
                    color = TerrariumColors.HUDText,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
                val trailing = subscriptionTrailing(sub.until, now)
                if (trailing != null) {
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        text = trailing.text,
                        color = if (trailing.expired) TerrariumColors.LEDAmber else TerrariumColors.HUDSubtext,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

// MARK: - Downstream rows
//
// On Android the dashboard is a pure client — D200H/Pixoo/Stream Deck/ESP32
// physically attach to the *daemon machine* (typically a Mac), not to the
// tablet/reader running this view. Mirroring the daemon's full downstream
// rail here would read as "these devices are mine", so we render a single
// self-row instead. iOS does the same in TopologyRail.swift.

@Composable
private fun DownstreamRows(scale: MonitorLayoutScale) {
    Column(verticalArrangement = Arrangement.spacedBy(scale.providerRowSpacing)) {
        DeviceRailRow(
            name = "This ${selfDeviceLabel()}",
            status = LEDStatus.OK,
            detail = "dashboard client",
        )
    }
}

/// Short label for the Android device showing the dashboard. Resolved by
/// `DeviceProfile` so the vendor names ("Crema", "Pantone", "Kobo") and the
/// form-factor fallback ("Phone", "TV", "Car") live in one place.
private fun selfDeviceLabel(): String = DeviceProfileHolder.current.shortLabel

// MARK: - Provider row + rate chip

private enum class LEDStatus(val color: Color, val glyph: String) {
    OK(TerrariumColors.LEDGreen, "●"),
    WARN(TerrariumColors.LEDAmber, "●"),
    ERROR(TerrariumColors.LEDRed, "●"),
    DIM(TerrariumColors.HUDSubtext.copy(alpha = 0.5f), "○"),
}

private data class RateChip(
    val label: String,
    val percent: Double,
    val reset: String?,
    /// Data-is-stale marker — when the bridge hasn't fetched fresh usage
    /// for > 10min the chip dims and shows `stale` in the reset slot so
    /// the cached value can't be mistaken for current data.
    val stale: Boolean = false,
)

@Composable
private fun ProviderRow(
    name: String,
    status: LEDStatus,
    subtitle: String?,
    consumers: List<Color>,
    rateLimits: List<RateChip>,
) {
    val tight = PlatformTextStyle(includeFontPadding = false)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = status.glyph,
                color = status.color,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = name,
                color = TerrariumColors.HUDText,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tight),
            )
            Spacer(modifier = Modifier.weight(1f))
            // Consumer creature dots — brand-colored, cap at 3 with +N.
            val visible = consumers.take(3)
            visible.forEach { color ->
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(color)
                        .border(
                            border = BorderStroke(0.5.dp, Color.Black.copy(alpha = 0.35f)),
                            shape = CircleShape,
                        ),
                )
                Spacer(modifier = Modifier.width(2.dp))
            }
            val overflow = consumers.size - visible.size
            if (overflow > 0) {
                Text(
                    text = "+$overflow",
                    color = TerrariumColors.HUDSubtext,
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (!subtitle.isNullOrEmpty()) {
            Text(
                text = subtitle,
                color = TerrariumColors.HUDSubtext,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 14.dp),
                style = TextStyle(platformStyle = tight),
            )
        }
        if (rateLimits.isNotEmpty()) {
            Column(
                verticalArrangement = Arrangement.spacedBy(2.dp),
                modifier = Modifier.padding(start = 14.dp, top = 2.dp),
            ) {
                rateLimits.forEach { chip -> RateChipView(chip) }
            }
        }
    }
}

@Composable
private fun RateChipView(chip: RateChip) {
    val pct = chip.percent.coerceIn(0.0, 100.0)
    val fillColor = when {
        pct >= 90 -> TerrariumColors.LEDRed
        pct >= 70 -> TerrariumColors.LEDAmber
        else -> TerrariumColors.LEDGreen
    }
    val fillFraction = (pct / 100.0).toFloat()
    // Dim the bar when the underlying value is stale — the user should
    // read it as "cached / don't trust" at a glance, same visual pattern
    // as the iOS TopologyRail.
    val barAlpha = if (chip.stale) 0.35f else 0.65f

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = chip.label,
            color = TerrariumColors.HUDSubtext,
            fontSize = 9.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.width(16.dp),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(5.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(Color.White.copy(alpha = 0.10f)),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(fillFraction)
                    .fillMaxSize()
                    .background(fillColor.copy(alpha = barAlpha), RoundedCornerShape(2.dp)),
            )
        }
        Text(
            text = "${pct.toInt()}%",
            color = if (chip.stale) TerrariumColors.HUDSubtext else fillColor,
            fontSize = 9.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.width(32.dp),
            textAlign = TextAlign.End,
        )
        when {
            chip.stale -> Text(
                text = "stale",
                color = TerrariumColors.LEDAmber,
                fontSize = 9.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.width(42.dp),
                textAlign = TextAlign.End,
            )
            chip.reset != null -> Text(
                text = chip.reset,
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.75f),
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.width(42.dp),
                textAlign = TextAlign.End,
            )
            else -> Text(
                text = "—",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.4f),
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.width(42.dp),
                textAlign = TextAlign.End,
            )
        }
    }
}

// MARK: - Provider inference + consumer resolution

private enum class ProviderKey { CLAUDE, OPENCLAW, CODEX, MLX, OLLAMA, ANTIGRAVITY, UNKNOWN }

/**
 * Best-effort mapping from a session's model name to a provider slot.
 * Mirrors the iOS `TopologyRail.providerFor(...)` switch — keep them in
 * sync when adding new providers or model families.
 */
private fun providerFor(
    agentType: String?,
    modelName: String?,
    mlxModels: List<String>,
    ollama: OllamaStatus?,
): ProviderKey {
    if (agentType == "antigravity") return ProviderKey.ANTIGRAVITY
    if (agentType == "codex-cli" || agentType == "codex-app") return ProviderKey.CODEX
    val raw = modelName?.lowercase().orEmpty()
    if (raw.isEmpty()) return ProviderKey.UNKNOWN
    if (raw.startsWith("claude-") || raw.startsWith("opus") ||
        raw.startsWith("sonnet") || raw.startsWith("haiku")
    ) return ProviderKey.CLAUDE
    if (raw.startsWith("glm") || raw.contains("qwen-plus") ||
        raw.contains("deepseek") || raw.startsWith("z-") ||
        raw.startsWith("gpt-") || raw.startsWith("o1-") || raw.startsWith("o3-")
    ) return ProviderKey.OPENCLAW
    for (m in mlxModels) {
        val lower = m.lowercase()
        if (raw.contains(lower) || lower.contains(raw)) return ProviderKey.MLX
    }
    if (ollama != null && ollama.models.any { raw.contains(it.name.lowercase()) }) {
        return ProviderKey.OLLAMA
    }
    return ProviderKey.UNKNOWN
}

/**
 * Return a de-duplicated list of consumer brand colors for the given
 * provider. Dedup keys on `agentType` so two Claude sessions eat one slot
 * on the Claude row instead of two.
 */
private fun consumersFor(provider: ProviderKey, state: DashboardState): List<Color> {
    val seen = mutableSetOf<String>()
    val result = mutableListOf<Color>()

    // Primary (local) session — only count if its model maps to this
    // provider and its agent type isn't already represented by a sibling.
    val primaryAgentType = state.agentType
    val primaryModel = state.modelName
    if (primaryAgentType != null && primaryAgentType != "daemon") {
        val key = primaryAgentType
        if (seen.add(key) &&
            providerFor(primaryAgentType, primaryModel, state.mlxModels, state.ollamaStatus) == provider
        ) {
            result += brandColorForAgent(primaryAgentType)
        }
    }

    for (session in state.siblingSessions) {
        val agent = session.agentType ?: continue
        if (agent == "daemon") continue
        val key = agent
        if (!seen.add(key)) continue
        val modelName = session.modelName
        if (providerFor(agent, modelName, state.mlxModels, state.ollamaStatus) == provider) {
            result += brandColorForAgent(agent)
        }
    }

    return result
}

/**
 * Build Codex usage chips, mirroring the Claude 5h/7d layout. One chip per
 * present window that carries a `usedPercent`; labels are derived from each
 * window's length (300 min → "5h", 10080 min → "7d"). Mirrors the iOS
 * `codexRateLimitChips`.
 */
private fun buildCodexRateChips(limits: CodexRateLimits?): List<RateChip> =
    // Shared mapping lives in util.codexLimitRows so the HUD rail and the e-ink
    // surfaces can't drift; only the reset-time formatting is rail-local.
    codexLimitRows(limits).map { row ->
        RateChip(label = row.label, percent = row.percent, reset = row.resetIso?.let { formatResetTime(it) }, stale = row.stale)
    }

/**
 * Friendly ChatGPT plan label from a raw `chatgpt_plan_type`. Returns null
 * when blank so the subtitle stays hidden. Mirrors iOS `chatGptPlanLabel`.
 */
private fun chatGptPlanLabel(raw: String?): String? {
    val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return when (trimmed.lowercase()) {
        "plus" -> "ChatGPT Plus"
        "pro" -> "ChatGPT Pro"
        "team" -> "ChatGPT Team"
        "enterprise" -> "ChatGPT Enterprise"
        else -> "ChatGPT $trimmed"
    }
}

/**
 * Codex row subtitle: plan label, plus a credits readout when the plan is
 * credit-based (null 5h/7d windows, e.g. `limit_id: "premium"`) so the Codex
 * usage doesn't read as empty. Mirrors iOS `codexSubtitle`.
 */
private fun codexSubtitle(plan: String?, limits: CodexRateLimits?): String? {
    val planLabel = chatGptPlanLabel(plan)
    if (limits == null || limits.primary != null || limits.secondary != null ||
        (limits.credits == null && limits.limitId == null)
    ) {
        return planLabel
    }
    val tier = (limits.limitId ?: "credits").replaceFirstChar { it.uppercase() }
    val bal = if (limits.credits?.unlimited == true) "∞" else (limits.credits?.balance ?: "—")
    val creditsText = "$tier · $bal credits"
    return if (planLabel != null) "$planLabel · $creditsText" else creditsText
}

// MARK: - Device (downstream) row

@Composable
private fun DeviceRailRow(
    name: String,
    status: LEDStatus,
    detail: String,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = status.glyph,
            color = status.color,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = name,
            color = TerrariumColors.HUDText,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.widthIn(min = 72.dp),
        )
        Text(
            text = detail,
            color = TerrariumColors.HUDSubtext,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
