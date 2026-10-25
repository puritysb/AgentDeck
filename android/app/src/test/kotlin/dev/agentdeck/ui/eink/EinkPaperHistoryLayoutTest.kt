package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w1000dp-h1400dp-mdpi")
class EinkPaperHistoryLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `history keeps its position across rotation but resets for another same-name session`() {
        val inspectionId = mutableStateOf<String?>(null)
        val landscape = mutableStateOf(false)
        val frame = mutableStateOf(true)
        fun entries(id: String?) = (1..30).map {
            TimelineEntry(timestamp = it * 1_000L, type = "chat_response",
                summary = "$id finished review item $it.", projectName = "Duplicated workspace")
        }
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(
                    state = DashboardState(agentType = "daemon"),
                    timelineEntries = entries(inspectionId.value),
                    landscape = landscape.value,
                    onFocusSession = {},
                    usage = emptyList(),
                    sleepSnapshotMode = false,
                    modifier = Modifier.requiredSize(if (landscape.value) 800.dp else 400.dp,
                        if (landscape.value) 400.dp else 760.dp),
                    inspectionLabel = inspectionId.value?.let { "Duplicated workspace" },
                    inspectionSessionId = inspectionId.value,
                    onClearInspection = { inspectionId.value = null },
                    frameMode = frame.value,
                    onExitFrame = { frame.value = false },
                    tank = { Box(it) },
                )
            }
        }
        compose.runOnIdle { inspectionId.value = "Session A" }
        compose.onNodeWithTag("paper-history").assertIsDisplayed()
        compose.onNodeWithText("Session A finished review item 1.").performScrollTo().assertIsDisplayed()
        fun scrollOffset() = compose.onNodeWithTag("paper-history-scroll").fetchSemanticsNode()
            .config[SemanticsProperties.VerticalScrollAxisRange].value()
        assertTrue("History did not reach the older work", scrollOffset() > 100)

        compose.runOnIdle { landscape.value = true }
        assertTrue("Rotation discarded the reading position", scrollOffset() > 100)
        compose.runOnIdle { inspectionId.value = "Session B" }
        assertEquals("A different session inherited an old scroll position", 0f, scrollOffset(), 0.1f)
        compose.onNodeWithText("Session B finished review item 30.").assertIsDisplayed()
        compose.onNodeWithText("Back to Frame").performClick()
        compose.onNodeWithTag("paper-terrarium").assertIsDisplayed()
        compose.onNodeWithTag("paper-history").assertDoesNotExist()
    }
}
