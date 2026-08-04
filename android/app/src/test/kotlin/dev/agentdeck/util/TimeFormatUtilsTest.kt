package dev.agentdeck.util

import dev.agentdeck.net.CodexRateLimits
import dev.agentdeck.net.CodexRateLimitWindow
import org.junit.Assert.*
import org.junit.Test

class TimeFormatUtilsTest {

    // --- formatCount ---

    @Test
    fun `formatCount small numbers unchanged`() {
        assertEquals("0", formatCount(0))
        assertEquals("1", formatCount(1))
        assertEquals("999", formatCount(999))
    }

    @Test
    fun `formatCount thousands show K`() {
        assertEquals("1.0K", formatCount(1000))
        assertEquals("1.5K", formatCount(1500))
        assertEquals("999.9K", formatCount(999_900))
    }

    @Test
    fun `formatCount millions show M`() {
        assertEquals("1.0M", formatCount(1_000_000))
        assertEquals("1.5M", formatCount(1_500_000))
        assertEquals("10.0M", formatCount(10_000_000))
    }

    @Test
    fun `formatCount int overload works`() {
        val n: Int = 1000
        assertEquals("1.0K", formatCount(n))
    }

    // --- gaugeBar ---

    @Test
    fun `gaugeBar 0 percent is all empty`() {
        assertEquals("░░░░░░", gaugeBar(0.0))
    }

    @Test
    fun `gaugeBar 100 percent is all filled`() {
        assertEquals("██████", gaugeBar(100.0))
    }

    @Test
    fun `gaugeBar 50 percent is half filled`() {
        assertEquals("███░░░", gaugeBar(50.0))
    }

    @Test
    fun `gaugeBar custom width`() {
        assertEquals("████████░░", gaugeBar(80.0, 10))
    }

    @Test
    fun `gaugeBar clamps above 100`() {
        assertEquals("██████", gaugeBar(150.0))
    }

    @Test
    fun `gaugeBar clamps below 0`() {
        assertEquals("░░░░░░", gaugeBar(-10.0))
    }

    // --- formatBytes ---

    @Test
    fun `formatBytes small values`() {
        assertEquals("0B", formatBytes(0))
        assertEquals("512B", formatBytes(512))
    }

    @Test
    fun `formatBytes kilobytes`() {
        assertEquals("1K", formatBytes(1024))
        assertEquals("10K", formatBytes(10_240))
    }

    @Test
    fun `formatBytes megabytes`() {
        assertEquals("1M", formatBytes(1_048_576))
        assertEquals("512M", formatBytes(536_870_912))
    }

    @Test
    fun `formatBytes gigabytes`() {
        assertEquals("1.0G", formatBytes(1_073_741_824))
        assertEquals("4.5G", formatBytes(4_831_838_208))
    }

    // --- formatDurationCompact ---

    @Test
    fun `formatDurationCompact sub-second`() {
        assertEquals("<1s", formatDurationCompact(0))
        assertEquals("<1s", formatDurationCompact(999))
    }

    @Test
    fun `formatDurationCompact seconds`() {
        assertEquals("1s", formatDurationCompact(1000))
        assertEquals("45s", formatDurationCompact(45_000))
    }

    @Test
    fun `formatDurationCompact minutes`() {
        assertEquals("1m", formatDurationCompact(60_000))
        assertEquals("2m 5s", formatDurationCompact(125_000))
    }

    @Test
    fun `formatDurationCompact exact minutes no seconds`() {
        assertEquals("5m", formatDurationCompact(300_000))
    }

    // --- formatResetTime ---

    @Test
    fun `formatResetTime returns original on parse failure`() {
        assertEquals("not-a-date", formatResetTime("not-a-date"))
    }

    // --- formatUptime ---

    @Test
    fun `formatUptime zero returns 0 colon 00`() {
        assertEquals("0:00", formatUptime(0))
        assertEquals("0:00", formatUptime(-1))
    }

    // --- windowLabel ---

    @Test
    fun `windowLabel maps minutes to compact day-hour-minute labels`() {
        assertEquals("5h", windowLabel(300))
        assertEquals("7d", windowLabel(10080)) // days checked first: 10080 -> 7d not 168h
        assertEquals("1h", windowLabel(60))
        assertEquals("45m", windowLabel(45))
        assertEquals("·", windowLabel(null))
        assertEquals("·", windowLabel(0))
    }

    // --- codexLimitRows ---

    @Test
    fun `codexLimitRows returns empty when limits null`() {
        assertTrue(codexLimitRows(null).isEmpty())
    }

    @Test
    fun `codexLimitRows maps primary and secondary windows with agent tag`() {
        val rows = codexLimitRows(
            CodexRateLimits(
                primary = CodexRateLimitWindow(usedPercent = 67.0, windowMinutes = 300, resetsAt = "2026-06-29T15:00:00Z"),
                secondary = CodexRateLimitWindow(usedPercent = 9.0, windowMinutes = 10080, stale = true),
            ),
        )
        assertEquals(2, rows.size)
        assertEquals("codex", rows[0].agentType)
        assertEquals("5h", rows[0].label)
        assertEquals(67.0, rows[0].percent, 0.0)
        assertEquals("2026-06-29T15:00:00Z", rows[0].resetIso)
        assertFalse(rows[0].stale)
        assertEquals("7d", rows[1].label)
        assertTrue(rows[1].stale)
    }

    // --- Codex snapshot freshness (mirror of shared/src/format-utils.ts) ---
    //
    // Codex usage is a passive read of local rollout files, so the numbers freeze
    // the moment Codex stops being used. `stale` cannot expose that — it fires only
    // once the WINDOW has ended, and the weekly window stays in the future for up
    // to 7 days. Lockstep with `shared/src/__tests__/format-utils.test.ts`.

    private val freshnessNow = 1786001220000L // 2026-08-05T07:27:00Z
    private fun capturedAgo(ms: Long): String =
        java.time.Instant.ofEpochMilli(freshnessNow - ms).toString()

    @Test
    fun `codex snapshot threshold matches the TypeScript SSOT`() {
        assertEquals(30 * 60_000L, CodexFreshnessRules.SNAPSHOT_STALE_MS)
    }

    @Test
    fun `codex snapshot age ignores missing and malformed stamps`() {
        assertEquals(null, CodexFreshnessRules.snapshotAgeMs(null, freshnessNow))
        assertEquals(null, CodexFreshnessRules.snapshotAgeMs("not-a-date", freshnessNow))
        assertEquals(null, CodexFreshnessRules.footnote(false, "not-a-date", freshnessNow))
    }

    @Test
    fun `codex snapshot age label rounds down`() {
        assertEquals("now", CodexFreshnessRules.formatSnapshotAge(capturedAgo(59_000), freshnessNow))
        assertEquals("34m ago", CodexFreshnessRules.formatSnapshotAge(capturedAgo(34 * 60_000 + 59_000), freshnessNow))
        assertEquals("3h ago", CodexFreshnessRules.formatSnapshotAge(capturedAgo(3 * 3_600_000 + 59 * 60_000), freshnessNow))
        assertEquals("1d ago", CodexFreshnessRules.formatSnapshotAge(capturedAgo(47 * 3_600_000), freshnessNow))
    }

    @Test
    fun `codex footnote fires only past the threshold`() {
        assertEquals(null, CodexFreshnessRules.footnote(false, capturedAgo(CodexFreshnessRules.SNAPSHOT_STALE_MS), freshnessNow))
        assertEquals("30m ago", CodexFreshnessRules.footnote(false, capturedAgo(CodexFreshnessRules.SNAPSHOT_STALE_MS + 1000), freshnessNow))
    }

    @Test
    fun `codex footnote ended window outranks age`() {
        assertEquals("stale", CodexFreshnessRules.footnote(true, capturedAgo(5 * 3_600_000), freshnessNow))
    }

    @Test
    fun `codexLimitRows dates an aged reading of a still-live weekly window`() {
        // THE REGRESSION: reset six days out (not stale), snapshot four hours old.
        val rows = codexLimitRows(
            CodexRateLimits(
                primary = CodexRateLimitWindow(usedPercent = 94.0, windowMinutes = 10080, resetsAt = "2026-08-11T14:46:25Z"),
                capturedAt = capturedAgo(4 * 3_600_000),
            ),
            freshnessNow,
        )
        assertEquals(1, rows.size)
        assertEquals(94.0, rows[0].percent, 0.0) // never blanked — last true reading
        assertFalse(rows[0].stale)               // the window itself is still live
        assertEquals("4h ago", rows[0].footnote) // ...but the number is not current
    }

    @Test
    fun `codexLimitRows leaves a legacy producer without capturedAt unchanged`() {
        val rows = codexLimitRows(
            CodexRateLimits(
                primary = CodexRateLimitWindow(usedPercent = 94.0, windowMinutes = 10080, resetsAt = "2026-08-11T14:46:25Z"),
            ),
            freshnessNow,
        )
        assertEquals(null, rows[0].footnote)
    }

    @Test
    fun `codexLimitRows skips windows with null usedPercent`() {
        val rows = codexLimitRows(
            CodexRateLimits(
                primary = CodexRateLimitWindow(usedPercent = null, windowMinutes = 300),
                secondary = CodexRateLimitWindow(usedPercent = 12.0, windowMinutes = 10080),
            ),
        )
        assertEquals(1, rows.size)
        assertEquals("7d", rows[0].label)
    }
}
