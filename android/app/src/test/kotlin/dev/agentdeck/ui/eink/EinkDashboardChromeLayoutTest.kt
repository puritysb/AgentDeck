package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import dev.agentdeck.data.DashboardOrientation
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.DotSurfaceSnapshot
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.ui.screen.EinkDashboardChromeBar
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w400dp-h760dp-mdpi", fontScale = 1.8f)
class EinkDashboardChromeLayoutTest {
    @get:Rule val compose = createComposeRule()

    private fun sessions(count: Int) = DashboardState(
        agentType = "daemon",
        siblingSessions = (1..count).map {
            SessionInfo(id = "s$it", port = 9120, projectName = "Long workspace name $it",
                agentType = "claude-code", alive = true, state = "processing")
        },
        dot = DotSurfaceSnapshot(configured = true, hosting = true),
    )

    @Test fun `large text keeps clock and touch controls visible with Dot on its own line`() {
        val prefs = DisplayPreferences(RuntimeEnvironment.getApplication(), isEink = true)
        runBlocking { prefs.setOrientation(DashboardOrientation.Portrait) }
        var settingsClicks = 0
        val frameMode = mutableStateOf(false)
        compose.setContent {
            MaterialTheme {
                EinkDashboardChromeBar(sessions(32), "23:59", prefs, true,
                    onSettingsClick = { settingsClicks++ }, modifier = Modifier.requiredWidth(400.dp),
                    frameMode = frameMode.value, onToggleFrame = { frameMode.value = !frameMode.value })
            }
        }

        assertTextFits("AgentDeck", "23:59", "Frame", "Dot · AWAITING ACTIVITY")
        val frame = compose.onNodeWithContentDescription("Open frame mode").assertIsDisplayed().assertHasClickAction()
        val rotate = compose.onNodeWithContentDescription("Rotate screen").assertIsDisplayed().assertHasClickAction()
        val settings = compose.onNodeWithContentDescription("Settings").assertIsDisplayed().assertHasClickAction()
        val frameBounds = frame.fetchSemanticsNode().boundsInRoot
        val rotateBounds = rotate.fetchSemanticsNode().boundsInRoot
        val settingsBounds = settings.fetchSemanticsNode().boundsInRoot
        assertTrue("Frame lost its touch target", frameBounds.width >= 44 && frameBounds.height >= 44)
        assertTrue("Frame overlaps rotation", frameBounds.right <= rotateBounds.left)
        assertTrue("Frame must share the controls row", frameBounds.top < rotateBounds.bottom)
        assertTrue("Rotation lost its touch target", rotateBounds.width >= 44 && rotateBounds.height >= 44)
        assertTrue("Settings lost its touch target", settingsBounds.width >= 44 && settingsBounds.height >= 44)
        assertTrue("Settings was pushed past the screen", settingsBounds.right <= 400)
        val dotBounds = compose.onNodeWithText("Dot · AWAITING ACTIVITY").fetchSemanticsNode().boundsInRoot
        assertTrue("Dot must have a separate readable row", dotBounds.top >= rotateBounds.bottom)

        frame.performClick()
        compose.runOnIdle { assertTrue(frameMode.value) }
        compose.onNodeWithContentDescription("Open frame mode").assertDoesNotExist()
        compose.onNodeWithContentDescription("Return to work").assertIsDisplayed().assertHasClickAction()
        assertTextFits("Work")
        compose.onNodeWithContentDescription("Return to work").performClick()
        compose.runOnIdle { assertFalse(frameMode.value) }

        settings.performClick()
        compose.runOnIdle { assertEquals(1, settingsClicks) }
        rotate.performClick()
        compose.waitUntil(timeoutMillis = 5_000) {
            runBlocking { prefs.orientationFlow.first() } == DashboardOrientation.Landscape
        }
    }

    @Test fun `session growth cannot displace the clock or rotation when settings are hidden`() {
        val prefs = DisplayPreferences(RuntimeEnvironment.getApplication(), isEink = true)
        val state = mutableStateOf(sessions(1))
        compose.setContent {
            MaterialTheme {
                EinkDashboardChromeBar(state.value, "23:59", prefs, false, {},
                    modifier = Modifier.requiredWidth(400.dp))
            }
        }
        val initialClock = compose.onNodeWithText("23:59").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val initialRotation = compose.onNodeWithContentDescription("Rotate screen").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { state.value = sessions(32) }
        assertTextFits("AgentDeck", "23:59", "Dot · AWAITING ACTIVITY")
        assertEquals(initialClock, compose.onNodeWithText("23:59").fetchSemanticsNode().boundsInRoot)
        assertEquals(initialRotation, compose.onNodeWithContentDescription("Rotate screen").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithContentDescription("Open frame mode").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
        compose.onNodeWithContentDescription("Rotate screen").assertHasClickAction()
    }

    @Test fun `narrow large text retains frame rotation settings and the snapshot without another navigation row`() {
        val prefs = DisplayPreferences(RuntimeEnvironment.getApplication(), isEink = true)
        compose.setContent {
            MaterialTheme {
                EinkDashboardChromeBar(sessions(32), "23:59", prefs, true, {},
                    modifier = Modifier.requiredWidth(320.dp).testTag("narrow-header"))
            }
        }
        assertTextFits("AgentDeck", "23:59", "Frame", "Dot · AWAITING ACTIVITY")
        val header = compose.onNodeWithTag("narrow-header").fetchSemanticsNode().boundsInRoot
        val controls = listOf("Open frame mode", "Rotate screen", "Settings").map { label ->
            compose.onNodeWithContentDescription(label).assertIsDisplayed().assertHasClickAction()
                .fetchSemanticsNode().boundsInRoot
        }
        controls.forEach { bounds ->
            assertTrue("Control outside the narrow header: $bounds", bounds.left >= header.left && bounds.right <= header.right)
            assertTrue("Control lost its touch target: $bounds", bounds.width >= 44 && bounds.height >= 44)
        }
        controls.zipWithNext().forEach { (left, right) ->
            assertTrue("Controls overlap", left.right <= right.left)
            assertTrue("Controls grew a separate navigation row", left.top < right.bottom && right.top < left.bottom)
        }
        val clock = compose.onNodeWithText("23:59").fetchSemanticsNode().boundsInRoot
        assertTrue("Snapshot overlaps the frame control", clock.right <= controls.first().left)
    }

    private fun assertTextFits(vararg texts: String) {
        for (text in texts) {
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText(text).assertIsDisplayed()
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertTrue("No text layout for $text", layouts.isNotEmpty())
            for (layout in layouts) {
                for (line in 0 until layout.lineCount) {
                    assertFalse("Ellipsized: $text", layout.isLineEllipsized(line))
                    assertTrue("Clipped width: $text", layout.getLineRight(line) <= layout.size.width + 1)
                    assertTrue("Clipped height: $text", layout.getLineBottom(line) <= layout.size.height + 1)
                }
            }
        }
    }
}
