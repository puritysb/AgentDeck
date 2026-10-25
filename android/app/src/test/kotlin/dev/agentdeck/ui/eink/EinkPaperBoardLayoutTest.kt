package dev.agentdeck.ui.eink

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.ui.screen.EinkLimitLine
import dev.agentdeck.ui.screen.EinkUsageGroup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Exercise the actual AndroidView/ComposeView measurement boundary, not just dp arithmetic. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w1000dp-h1400dp-mdpi")
class EinkPaperBoardLayoutTest {
    @get:Rule val compose = createComposeRule()

    private fun sessions(count: Int) = DashboardState(agentType = "daemon", siblingSessions = (1..count).map {
        SessionInfo(id = "s$it", port = 9120, projectName = "Workspace $it", agentType = "claude-code",
            alive = true, state = "processing", modelName = "A model with a long activity description")
    })

    private val groups = listOf("Claude", "Codex", "GLM", "Antigravity").map { name ->
        EinkUsageGroup("claude-code", name, "Pro subscription · until October 31", listOf(
            EinkLimitLine("5h", percent = 41.0, reset = "2h 16m"),
            EinkLimitLine("7d", percent = 78.0, reset = "6d 15h"),
            EinkLimitLine("$name model window 3", percent = 35.0, reset = "4d 12h"),
            EinkLimitLine("$name model window 4", percent = 98.0, reset = "6d 23h"),
        ))
    }

    private fun render(landscape: Boolean) {
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(sessions(24), listOf(TimelineEntry(timestamp = 100, type = "chat_response",
                    summary = "Finished the layout regression checks")), landscape, {}, groups, false,
                    Modifier.requiredSize(if (landscape) 800.dp else 400.dp, if (landscape) 400.dp else 760.dp),
                    tank = { Box(it.fillMaxSize().testTag("mounted-tank")) })
            }
        }
    }

    private fun scrollOffset(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode()
        .config[SemanticsProperties.VerticalScrollAxisRange].value()

    private fun checkDashboardPanes(landscape: Boolean) {
        compose.onNodeWithTag("paper-dashboard").assertIsDisplayed()
        val work = compose.onNodeWithTag("paper-sessions").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val usage = compose.onNodeWithTag("paper-usage").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Work must retain a reading viewport: $work", work.width > 180 && work.height > 120)
        assertTrue("Usage must retain a reading viewport: $usage", usage.width > 180 && usage.height > 100)
        if (landscape) {
            assertTrue("Landscape usage must sit beside the roster", work.right <= usage.left + 1)
        } else {
            assertTrue("Portrait usage must sit below the roster", work.bottom <= usage.top + 1)
        }
        compose.onNodeWithTag("paper-terrarium").assertDoesNotExist()
        compose.onNodeWithTag("mounted-tank").assertDoesNotExist()
        for (page in listOf("overview", "sessions", "usage")) {
            compose.onNodeWithTag("paper-nav-$page").assertDoesNotExist()
        }
        compose.onNodeWithTag("paper-page-next").assertDoesNotExist()
        compose.onNodeWithTag("paper-page-previous").assertDoesNotExist()
    }

    private fun expandProvider(provider: String) {
        compose.onNodeWithTag("paper-usage-expand-$provider").performScrollTo().assertIsDisplayed().performClick()
    }

    private fun checkAllContentReachable(landscape: Boolean, lastSession: Int = 24) {
        val usageStart = scrollOffset("paper-usage-scroll")
        compose.onNodeWithText("Workspace $lastSession").performScrollTo().assertIsDisplayed()
        assertTrue("The full roster did not scroll", scrollOffset("paper-session-scroll") > 0)
        assertEquals("Reading the roster displaced usage", usageStart, scrollOffset("paper-usage-scroll"), 0.1f)
        val workEnd = scrollOffset("paper-session-scroll")
        for (provider in groups.map { it.provider }) {
            expandProvider(provider)
            compose.onNodeWithText("$provider model window 4", substring = true).performScrollTo().assertIsDisplayed()
        }
        assertTrue("The last provider did not remain reachable", scrollOffset("paper-usage-scroll") > 0)
        assertEquals("Reading provider details displaced the roster", workEnd,
            scrollOffset("paper-session-scroll"), 0.1f)
        compose.onNodeWithText("Workspace $lastSession").assertIsDisplayed()
        checkDashboardPanes(landscape)
    }

    @Test fun `portrait shows work and usage together while both full collections remain reachable`() {
        render(landscape = false)
        checkDashboardPanes(landscape = false)
        compose.onNodeWithText("Workspace 1").assertIsDisplayed()
        compose.onNodeWithText("Claude").assertIsDisplayed()
        checkAllContentReachable(landscape = false)
    }

    @Test fun `landscape shows work and usage together while both full collections remain reachable`() {
        render(landscape = true)
        checkDashboardPanes(landscape = true)
        compose.onNodeWithText("Workspace 1").assertIsDisplayed()
        compose.onNodeWithText("Claude").assertIsDisplayed()
        checkAllContentReachable(landscape = true)
    }

    @Test fun `frame mounts only when selected and returns to the board after rotation and recreation`() {
        val landscape = mutableStateOf(false)
        val restoration = StateRestorationTester(compose)
        var selectFrame: (Boolean) -> Unit = {}
        var dispatcher: OnBackPressedDispatcher? = null
        restoration.setContent {
            var frame by rememberSaveable { mutableStateOf(false) }
            selectFrame = { frame = it }
            dispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
            MaterialTheme {
                EinkPaperBoard(sessions(24), emptyList(), landscape.value, {}, groups, false,
                    Modifier.requiredSize(if (landscape.value) 800.dp else 400.dp,
                        if (landscape.value) 400.dp else 760.dp),
                    frameMode = frame, onExitFrame = { frame = false },
                    tank = { Box(it.fillMaxSize().testTag("mounted-tank")) })
            }
        }
        checkDashboardPanes(landscape = false)
        compose.runOnIdle { selectFrame(true) }
        compose.onNodeWithTag("mounted-tank").assertIsDisplayed()
        val portrait = compose.onNodeWithTag("paper-terrarium").fetchSemanticsNode().boundsInRoot
        assertTrue("Frame must give the portrait aquarium the reading area: $portrait",
            portrait.width >= 360 && portrait.height >= 500)
        compose.onNodeWithTag("paper-dashboard").assertDoesNotExist()
        compose.onNodeWithTag("paper-sessions").assertDoesNotExist()
        compose.onNodeWithTag("paper-usage").assertDoesNotExist()

        compose.runOnIdle { landscape.value = true }
        val wide = compose.onNodeWithTag("paper-terrarium").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Frame became a narrow landscape rail: $wide", wide.width >= 760 && wide.height >= 260)
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("mounted-tank").assertIsDisplayed()
        compose.runOnIdle {
            checkNotNull(dispatcher) { "Missing back dispatcher" }.onBackPressed()
        }
        checkDashboardPanes(landscape = true)
    }

    @Test @Config(fontScale = 1.8f)
    fun `large text wraps long balances labels plans and resets within the usage pane`() {
        val label = "Long per-model weekly allowance"
        val value = "123456789 credits"
        val reset = "waiting for the provider to refresh this window"
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(sessions(12), emptyList(), true, {}, listOf(
                    EinkUsageGroup("codex", "Codex", "Pro subscription · until October 31", listOf(
                        EinkLimitLine("5h", percent = 41.0, reset = "2h 16m"),
                        EinkLimitLine("7d", percent = 78.0, reset = "6d 15h"),
                        EinkLimitLine(label, value = value, reset = reset))),
                ), false, Modifier.requiredSize(640.dp, 440.dp), tank = { Box(it) })
            }
        }
        expandProvider("Codex")
        assertTextFits("Pro subscription · until October 31", "$label · $value", "resets in $reset")
        compose.onNodeWithTag("paper-sessions").assertIsDisplayed()
        compose.onNodeWithText("Workspace 12").performScrollTo().assertIsDisplayed()
    }

    private fun assertTextFits(vararg texts: String) {
        for (text in texts) {
            val node = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
            val layouts = mutableListOf<TextLayoutResult>()
            node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertTrue("No text layout for $text", layouts.isNotEmpty())
            // A cached paragraph can retain a wider layout width than the Text's
            // intrinsic size. Check the actual line extents and ellipsis instead.
            for (layout in layouts) {
                for (line in 0 until layout.lineCount) {
                    assertFalse("Ellipsized: $text", layout.isLineEllipsized(line))
                    assertTrue("Clipped width: $text", layout.getLineRight(line) <= layout.size.width + 1)
                    assertTrue("Clipped height: $text", layout.getLineBottom(line) <= layout.size.height + 1)
                }
            }
        }
    }

    @Test fun `collapsed details cannot resize the primary usage metrics`() {
        val visible = listOf(
            EinkLimitLine("5h", percent = 41.0, reset = "2h 16m"),
            EinkLimitLine("7d", percent = 78.0, reset = "6d 15h"),
        )
        val usage = mutableStateOf(listOf(EinkUsageGroup("claude-code", "Claude", null, visible)))
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(sessions(24), emptyList(), true, {}, usage.value, false,
                    Modifier.requiredSize(800.dp, 400.dp), tank = { Box(it) })
            }
        }
        val metrics = listOf("5h", "41%", "2h 16m", "7d", "78%", "6d 15h")
        fun metricBounds() = metrics.associateWith {
            compose.onNodeWithText(it).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        }
        val original = metricBounds()
        val hiddenLabel = "Extended weekly allowance for a specialized model family"
        val hiddenValue = "12345678901234567890 credits"
        compose.runOnIdle {
            usage.value = listOf(usage.value.single().copy(windows = visible + EinkLimitLine(
                hiddenLabel, value = hiddenValue,
                reset = "waiting for the provider to refresh this allowance",
            )))
        }
        assertEquals("A collapsed detail changed the readable primary columns", original, metricBounds())
        compose.onNodeWithText(hiddenLabel, substring = true).assertDoesNotExist()
        expandProvider("Claude")
        compose.onNodeWithText(hiddenLabel, substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(hiddenValue, substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test fun `critical hidden model limits are called out before expansion`() {
        val label = "Specialized model weekly cap"
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(sessions(24), emptyList(), false, {}, listOf(
                    EinkUsageGroup("claude-code", "Claude", null, listOf(
                        EinkLimitLine("5h", percent = 41.0, reset = "2h 16m"),
                        EinkLimitLine("7d", percent = 78.0, reset = "6d 15h"),
                        EinkLimitLine(label, percent = 97.0, reset = "6d 23h"),
                        EinkLimitLine("Reserved capacity", percent = 95.0, reset = "6d 23h", remaining = true),
                        EinkLimitLine("Old model reading", percent = 99.0, reset = "6d 23h", stale = true))),
                ), false, Modifier.requiredSize(400.dp, 760.dp), tank = { Box(it) })
            }
        }
        compose.onNodeWithTag("paper-usage-expand-Claude").performScrollTo().assertIsDisplayed()
        // A quiet first pair must never hide a nearly exhausted scoped allowance.
        compose.onNodeWithText("+3 more limits · 1 near limit").assertIsDisplayed()
        compose.onNodeWithText(label, substring = true).assertDoesNotExist()
        expandProvider("Claude")
        compose.onNodeWithText(label, substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("paper-sessions").assertIsDisplayed()
    }

    @Test @Config(fontScale = 1.8f)
    fun `portrait keeps both regions reachable at large system text sizes`() {
        render(landscape = false)
        checkDashboardPanes(landscape = false)
        checkAllContentReachable(landscape = false)
    }

    @Test fun `rotation and live growth retain the last session and expanded model allowance`() {
        val landscape = mutableStateOf(false)
        val state = mutableStateOf(sessions(1))
        val usage = mutableStateOf(groups.take(1))
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(state.value, emptyList(), landscape.value, {}, usage.value, false,
                    Modifier.requiredSize(if (landscape.value) 800.dp else 400.dp,
                        if (landscape.value) 400.dp else 760.dp), tank = { Box(it) })
            }
        }
        compose.runOnIdle { state.value = sessions(32); usage.value = groups }
        compose.onNodeWithText("Workspace 32").performScrollTo().assertIsDisplayed()
        expandProvider("Antigravity")
        compose.onNodeWithText("Antigravity model window 4", substring = true).performScrollTo().assertIsDisplayed()
        compose.runOnIdle { landscape.value = true }
        compose.onNodeWithText("Workspace 32").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Antigravity model window 4", substring = true).performScrollTo().assertIsDisplayed()
        checkDashboardPanes(landscape = true)
        compose.runOnIdle { landscape.value = false; usage.value = groups.takeLast(1) }
        compose.onNodeWithText("Workspace 32").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Antigravity model window 4", substring = true).performScrollTo().assertIsDisplayed()
        checkDashboardPanes(landscape = false)
    }

    @Test fun `hiding the session list gives usage the reading space without mounting the tank`() {
        val landscape = mutableStateOf(false)
        compose.setContent {
            MaterialTheme {
                EinkPaperBoard(sessions(24), emptyList(), landscape.value, {}, groups, false,
                    Modifier.requiredSize(if (landscape.value) 800.dp else 400.dp,
                        if (landscape.value) 400.dp else 760.dp), showSessionList = false,
                    tank = { Box(it.testTag("mounted-tank")) })
            }
        }
        for (wide in listOf(false, true)) {
            compose.runOnIdle { landscape.value = wide }
            compose.onNodeWithTag("paper-sessions").assertDoesNotExist()
            compose.onNodeWithTag("mounted-tank").assertDoesNotExist()
            val pane = compose.onNodeWithTag("paper-usage").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            assertTrue("Hidden roster left an unused column: $pane", pane.width >= if (wide) 740 else 340)
        }
        expandProvider("Antigravity")
        compose.onNodeWithText("Antigravity model window 4", substring = true).performScrollTo().assertIsDisplayed()
    }
}
