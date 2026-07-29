package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PermissionMode
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.AgentDeckLogo
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.component.stateColor
import dev.agentdeck.ui.component.agentDisplayLabel
import dev.agentdeck.ui.eink.agentTypeRank
import dev.agentdeck.ui.eink.compareSessionsForDisplay
import dev.agentdeck.ui.eink.sessionWeight
import dev.agentdeck.ui.eink.compactStateMarker
import dev.agentdeck.ui.eink.mapSessionState
import dev.agentdeck.ui.eink.naturalLabelCompare
import dev.agentdeck.util.groupSessionsByProject
import dev.agentdeck.util.normalizeProjectForGrouping

/**
 * Left HUD panel — AgentDeck logo + unified session list (primary + siblings).
 * Replaces the old MultiAgentPanel with a comprehensive session overview.
 */
@Composable
fun SessionListPanel(
    projectName: String?,
    agentType: String?,
    modelName: String?,
    effortLevel: String? = null,
    agentState: AgentState,
    sessionId: String?,
    siblingSessions: List<SessionInfo>,
    workerSessionCount: Int?,
    permissionMode: PermissionMode = PermissionMode.DEFAULT,
    scale: MonitorLayoutScale = MonitorLayoutScale.phone,
    onFocusSession: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    // Build unified entry list: primary + siblings (excluding self)
    data class SessionEntry(
        val projectName: String,
        val agentType: String?,
        val modelName: String?,
        val effortLevel: String?,
        val agentState: AgentState,
        val startedAt: String?,
        val weight: Int? = null,
        val isPrimary: Boolean,
        val sessionId: String?,
        val activity: String? = null,
    )

    fun compareEntries(left: SessionEntry, right: SessionEntry): Int {
        // Three-way comparison, never subtraction — mirrors shared sortSessions.
        val weightDiff = sessionWeight(left.weight).compareTo(sessionWeight(right.weight))
        if (weightDiff != 0) return weightDiff

        val typeDiff = agentTypeRank(left.agentType) - agentTypeRank(right.agentType)
        if (typeDiff != 0) return typeDiff

        val nameDiff = naturalLabelCompare(left.projectName, right.projectName)
        if (nameDiff != 0) return nameDiff

        val leftStarted = left.startedAt
        val rightStarted = right.startedAt
        if (leftStarted != null && rightStarted != null && leftStarted != rightStarted) {
            return leftStarted.compareTo(rightStarted)
        }
        if (leftStarted != null) return -1
        if (rightStarted != null) return 1

        return naturalLabelCompare(left.sessionId, right.sessionId)
    }

    val entries = mutableListOf<SessionEntry>()

    // Daemon-like detection: skip primary if daemon, if it's the OpenClaw gateway
    // proxy (always virtualized into siblings), or if sessions already contain an
    // entry with the same agentType. Hardening "openclaw" unconditionally protects
    // against a race between state_update and sessions_list where the primary
    // briefly carries agentType=openclaw + agentState=DISCONNECTED.
    //
    // Mirrors macOS SessionListPanel.swift's primaryBackedBySibling /
    // duplicatePrimaryWithoutId guard so newly-started sessions don't disappear
    // for the 5–15 s race window between state_update and sessions_list.
    val primaryAnchorSibling = sessionId?.let { sid -> siblingSessions.firstOrNull { it.id == sid } }
    val primaryBackedBySibling = primaryAnchorSibling != null
    val duplicatePrimaryWithoutId = sessionId == null &&
        agentType != null &&
        siblingSessions.any { it.agentType == agentType }
    val isDaemonLike = agentType == "daemon" ||
        agentType == "openclaw" ||
        (!primaryBackedBySibling && duplicatePrimaryWithoutId)
    if (!isDaemonLike) {
        entries += SessionEntry(
            projectName = projectName ?: "Agent",
            agentType = agentType,
            modelName = modelName,
            effortLevel = effortLevel,
            agentState = agentState,
            // Borrow startedAt from the matching sibling so primary anchors
            // at a deterministic spot inside its (project, agentType) group.
            // Without this the #N suffix flips depending on event arrival order.
            startedAt = primaryAnchorSibling?.startedAt,
            weight = primaryAnchorSibling?.weight,
            isPrimary = true,
            sessionId = sessionId,
            activity = primaryAnchorSibling?.activity,
        )
    }

    // Siblings (skip self and daemon), stable sort: agentType → numeric-aware
    // projectName → startedAt → id. Must match Apple/shared sortSessions.
    //
    // The "skip self" filter must only fire when we actually added a primary
    // entry above. In daemon-like mode no primary entry was added — and
    // `sessionId` is the focused session id (propagated from
    // `state_update.sessionId`), so using it as a filter would silently
    // drop the focused sibling row. Same trap as EinkAgentColumn 2026-05-11.
    val primarySessionId = if (!isDaemonLike) sessionId else null
    siblingSessions
        .filter { it.id != primarySessionId && it.agentType != "daemon" }
        .sortedWith(::compareSessionsForDisplay)
        .forEach { session ->
            entries += SessionEntry(
                projectName = session.projectName ?: "Agent",
                agentType = session.agentType,
                modelName = session.modelName,
                effortLevel = null,
                agentState = mapSessionState(session),
                startedAt = session.startedAt,
                weight = session.weight,
                isPrimary = false,
                sessionId = session.id,
                activity = session.activity,
            )
        }
    val displayEntries = entries.sortedWith(::compareEntries)

    // Count occurrences per (projectName, agentType) for #N suffix —
    // different agent types (🦞 vs 🐙) with the same project name don't need numbering
    data class NameKey(val projectName: String, val agentType: String?)
    val nameCounts = entries.groupBy { NameKey(it.projectName, it.agentType) }
        .mapValues { it.value.size }
    val nameCounters = mutableMapOf<NameKey, Int>()

    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(scale.panelPadding),
        verticalArrangement = Arrangement.spacedBy(scale.sessionRowSpacing),
    ) {
        // Brand logo
        AgentDeckLogo(isEink = false, modifier = Modifier.fillMaxWidth())
        Spacer(modifier = Modifier.height(4.dp))

        // Permission mode badge — hidden (too noisy, mode info visible on SD+ already)
        if (false && permissionMode != PermissionMode.DEFAULT) {
            Text(
                text = "mode:${permissionMode.name.lowercase()}",
                color = TerrariumColors.HUDSubtext,
                fontSize = scale.fontSub,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .background(TerrariumColors.HUDBg, RoundedCornerShape(4.dp))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }

        Spacer(modifier = Modifier.height(2.dp))

        // One session row (icon + name + model/state + activity). Extracted so
        // grouped and flat entries render identically apart from label/indent.
        @Composable
        fun sessionRow(entry: SessionEntry, label: String, indent: Boolean) {
            val stateMarker = compactStateMarker(entry.agentState)
            val modelEffort = when {
                entry.modelName != null && entry.effortLevel != null
                    && entry.effortLevel != "medium" && entry.effortLevel != "default" ->
                    "${entry.modelName} \u00B7 ${entry.effortLevel}"
                entry.modelName != null -> entry.modelName
                else -> null
            }
            val subLine = if (modelEffort != null) {
                "$modelEffort \u00B7 $stateMarker"
            } else {
                stateMarker
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (indent) Modifier.padding(start = 10.dp) else Modifier)
                    .then(
                        if (entry.sessionId != null) {
                            Modifier.clickable { onFocusSession(entry.sessionId) }
                        } else {
                            Modifier
                        }
                    ),
            ) {
                // Agent brand icon + session name
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    BrandIcon(agentType = entry.agentType, isEink = false)
                    Text(
                        text = label,
                        color = TerrariumColors.HUDText,
                        fontSize = scale.fontBody,
                        fontWeight = if (entry.isPrimary) FontWeight.Bold else FontWeight.Normal,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Model · state (state colored)
                Text(
                    text = subLine,
                    color = stateColor(entry.agentState),
                    fontSize = scale.fontSub,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                // Shared activity one-liner (bridge SSOT) — same summary the
                // InkDeck e-ink cards show, so surfaces don't drift.
                if (entry.activity != null) {
                    Text(
                        text = entry.activity,
                        color = TerrariumColors.HUDSubtext,
                        fontSize = scale.fontSub,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        // #N suffix for duplicate sessions of the same agent type
        fun suffixFor(entry: SessionEntry): String {
            val key = NameKey(entry.projectName, entry.agentType)
            if ((nameCounts[key] ?: 1) <= 1) return ""
            val idx = (nameCounters[key] ?: 0) + 1
            nameCounters[key] = idx
            return " #$idx"
        }

        // Session entries — clustered into project work groups (IPS10 office
        // huddle port, see dev.agentdeck.util.SessionGrouping). Worktree/task
        // folders sharing a long prefix render under one group header with
        // only their differentiating tail; singletons render flat.
        //
        // Scrollable: with 8+ concurrent sessions the list used to overflow the
        // unbounded panel and paint over the timeline strip below. The call
        // site caps the panel height (heightIn), so weight(fill=false) hands
        // the entries whatever space the logo leaves, and overflow scrolls.
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(scale.sessionRowSpacing),
        ) {
        val groups = groupSessionsByProject(displayEntries) { it.projectName }
        groups.forEach { group ->
            if (group.grouped) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(TerrariumColors.HUDSubtext.copy(alpha = 0.12f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                ) {
                    Text(
                        text = group.key,
                        color = TerrariumColors.HUDSubtext,
                        fontSize = scale.fontSub,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Text(
                        text = "×${group.members.size}",
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                        fontSize = scale.fontSub,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                group.members.forEach { entry ->
                    sessionRow(
                        entry = entry,
                        label = groupMemberLabel(group.key, entry.projectName, entry.agentType) + suffixFor(entry),
                        indent = true,
                    )
                }
            } else {
                val entry = group.members[0]
                sessionRow(entry = entry, label = entry.projectName + suffixFor(entry), indent = false)
            }
        }

        // Worker count
        if (workerSessionCount != null && workerSessionCount > 0) {
            Text(
                text = "Workers: $workerSessionCount",
                color = TerrariumColors.HUDText,
                fontSize = scale.fontSub,
                fontFamily = FontFamily.Monospace,
            )
        }
        }
    }
}

/**
 * Display label for a member row under a project group header. The header
 * already carries the shared stem, so the row shows only the differentiating
 * tail ("claude-glm" under "xteink-x3-x4-japanese-broken"). Exact-duplicate
 * members (same project run twice) fall back to the agent display name — the
 * caller's #N suffix disambiguates.
 */
private fun groupMemberLabel(groupKey: String, projectName: String, agentType: String?): String {
    val norm = normalizeProjectForGrouping(projectName)
    if (norm.length > groupKey.length && norm.startsWith(groupKey, ignoreCase = true)) {
        val rest = norm.substring(groupKey.length).trimStart('-', '_', ' ', '.')
        if (rest.isNotEmpty()) return rest
    }
    if (norm.equals(groupKey, ignoreCase = true)) {
        val agent = agentDisplayLabel(agentType)
        if (agent.isNotEmpty()) return agent
    }
    return projectName
}
