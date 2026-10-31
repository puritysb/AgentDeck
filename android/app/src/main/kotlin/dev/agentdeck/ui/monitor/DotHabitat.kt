package dev.agentdeck.ui.monitor

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.agentdeck.net.DotHabitatRules
import dev.agentdeck.net.DotSurfaceSnapshot
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay

/** Separate water pocket for the orb; never adds a synthetic coding session. */
@Composable
fun DotHabitat(dot: DotSurfaceSnapshot, labelsVisible: Boolean) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var seconds by remember { mutableDoubleStateOf(0.0) }
    var motion by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(dot, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) { now = System.currentTimeMillis(); delay(1000) }
        }
    }
    val working = dot.effectiveCode(now) == 2
    LaunchedEffect(working, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (working) while (true) {
                val enabled = (currentCoroutineContext()[MotionDurationScale]?.scaleFactor ?: 1f) > 0f
                if (!enabled) { motion = false; delay(1000); continue }
                withFrameNanos { stamp ->
                    motion = true
                    seconds = stamp / 1_000_000_000.0
                }
            }
        }
    }
    if (!dot.inhabitsHabitat(now)) return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val side = (maxHeight.value * DotHabitatRules.sizeFraction).coerceIn(DotHabitatRules.minSize, DotHabitatRules.maxSize).dp
        val (dx, dy) = DotHabitatRules.offset(seconds, working, motion)
        val x = maxWidth * (DotHabitatRules.homeX + dx * DotHabitatRules.travelX).toFloat() - side / 2
        val y = maxHeight * (DotHabitatRules.homeY + dy * DotHabitatRules.travelY).toFloat() - side / 2
        DotCompanion(dot, Modifier.offset(x, y), style = DotCompanionStyle.Habitat, showLabel = labelsVisible, glyphSize = side)
    }
}
