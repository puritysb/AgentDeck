package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.aquariumResidents
import dev.agentdeck.terrarium.visibleAquariumResidents
import dev.agentdeck.terrarium.renderer.EinkTerrariumView

/**
 * An observation window into the live habitat, in either reader orientation.
 * Scene activity is separate from the dashboard roster and quota regions.
 */
@Composable
fun EinkAquariumFrame(
    state: TerrariumState,
    modifier: Modifier = Modifier,
    snapshotMode: Boolean = false,
    onFrameRendered: ((isAnimationFrame: Boolean) -> Unit)? = null,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(8.dp)),
    ) {
        EinkTerrariumView(
            state = state,
            modifier = Modifier.fillMaxSize(),
            snapshotMode = snapshotMode,
            onFrameRendered = onFrameRendered,
        )
        val residents = aquariumResidents(state)
        val visible = visibleAquariumResidents(residents, state.focusedSessionId)
        val shown = visible.size
        val activity = listOfNotNull(
            visible.count { it.state == OctopusVisualState.WORKING && it.ciWait?.agentWaiting != true }.takeIf { it > 0 }?.let { "$it working" },
            visible.count { it.state == OctopusVisualState.ASKING || it.ciWait?.agentWaiting == true }.takeIf { it > 0 }?.let { "$it waiting" },
            visible.count { it.state == OctopusVisualState.FLOATING && it.ciWait?.agentWaiting != true }.takeIf { it > 0 }?.let { "$it resting" },
            visible.count { it.state == OctopusVisualState.SLEEPING && it.ciWait?.agentWaiting != true }.takeIf { it > 0 }?.let { "$it sleeping" },
        ).joinToString(" · ")
        Row(Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(8.dp)) {
            Text(if (activity.isEmpty()) "Quiet habitat" else "In view · $activity",
                color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp,
                modifier = Modifier.weight(1f).padding(end = 8.dp))
            if (residents.size > shown) {
                Text("$shown of ${residents.size}",
                    color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.background(MaterialTheme.colorScheme.surface).padding(horizontal = 4.dp))
            }
        }
    }
}

/**
 * Backward-compatible alias for [EinkAquariumFrame].
 */
@Composable
fun EinkPictureFrame(
    state: TerrariumState,
    modifier: Modifier = Modifier,
    snapshotMode: Boolean = false,
    onFrameRendered: ((isAnimationFrame: Boolean) -> Unit)? = null,
) {
    EinkAquariumFrame(
        state = state,
        modifier = modifier,
        snapshotMode = snapshotMode,
        onFrameRendered = onFrameRendered,
    )
}
