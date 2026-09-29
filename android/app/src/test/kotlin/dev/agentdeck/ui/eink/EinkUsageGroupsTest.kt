package dev.agentdeck.ui.eink

import dev.agentdeck.net.AntigravityStatusInfo
import dev.agentdeck.net.CodexRateLimitWindow
import dev.agentdeck.net.CodexRateLimits
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.DashboardState
import dev.agentdeck.ui.screen.buildEinkUsageGroups
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The usage zone must hold up for every subscription mix, not only "all of them". */
class EinkUsageGroupsTest {
    private val now = Instant.parse("2026-09-28T00:00:00Z")

    private val claude = UsageUpdate(fiveHourPercent = 24.0, sevenDayPercent = 22.0)
    private val codex = CodexRateLimits(secondary = CodexRateLimitWindow(usedPercent = 27.0, windowMinutes = 10080))

    @Test
    fun `no subscription draws no zone`() {
        assertTrue(buildEinkUsageGroups(DashboardState(), now).isEmpty())
    }

    @Test
    fun `one provider is one group with its own windows`() {
        val groups = buildEinkUsageGroups(DashboardState(usage = claude), now)
        assertEquals(listOf("Claude"), groups.map { it.provider })
        assertEquals(listOf("5h", "7d"), groups.single().windows.map { it.label })
    }

    @Test
    fun `a plan attaches to its own provider, with a readable until`() {
        val groups = buildEinkUsageGroups(
            DashboardState(
                codexRateLimits = codex,
                subscriptions = listOf(SubscriptionInfo("ChatGPT Pro", "2026-10-10T00:00:00Z")),
            ),
            now,
        )
        assertEquals("Codex", groups.single().provider)
        assertEquals("Pro · until Oct 10", groups.single().plan)
    }

    @Test
    fun `the Swift daemon's plan fields give the same plan line as a subscription row`() {
        // The App Store daemon sends no ChatGPT subscription row, only these.
        val swift = buildEinkUsageGroups(
            DashboardState(
                codexRateLimits = codex,
                usage = UsageUpdate(codexPlanType = "pro", codexSubscriptionActiveUntil = "2026-10-10T00:00:00Z"),
            ),
            now,
        )
        val node = buildEinkUsageGroups(
            DashboardState(
                codexRateLimits = codex,
                subscriptions = listOf(SubscriptionInfo("ChatGPT Pro", "2026-10-10T00:00:00Z")),
            ),
            now,
        )
        assertEquals(node.single().plan, swift.single().plan)
        assertEquals("Pro · until Oct 10", swift.single().plan)
    }

    @Test
    fun `a lapsed plan asks for renewal`() {
        val groups = buildEinkUsageGroups(
            DashboardState(
                codexRateLimits = codex,
                subscriptions = listOf(SubscriptionInfo("ChatGPT Plus", "2026-09-01T00:00:00Z")),
            ),
            now,
        )
        assertEquals("Plus · renew", groups.single().plan)
    }

    @Test
    fun `a plan without metered windows is a group of its own`() {
        val groups = buildEinkUsageGroups(
            DashboardState(antigravityStatus = AntigravityStatusInfo(planName = "Google AI Pro")),
            now,
        )
        assertEquals("Antigravity", groups.single().provider)
        assertEquals("Pro", groups.single().plan)
        assertTrue(groups.single().windows.isEmpty())
    }

    @Test
    fun `providers keep one order whatever arrives first`() {
        val groups = buildEinkUsageGroups(
            DashboardState(
                usage = claude,
                codexRateLimits = codex,
                antigravityStatus = AntigravityStatusInfo(planName = "Google AI Pro"),
            ),
            now,
        )
        assertEquals(listOf("Claude", "Codex", "Antigravity"), groups.map { it.provider })
    }
}
