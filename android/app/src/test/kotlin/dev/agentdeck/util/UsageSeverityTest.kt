package dev.agentdeck.util

import org.junit.Assert.assertEquals
import org.junit.Test

class UsageSeverityTest {
    @Test fun consumedAndRemainingUseTheSameBoundaryAndPalette() {
        assertEquals(UsageSeverity.Level.UNKNOWN, UsageSeverity.level(Double.NaN))
        assertEquals(UsageSeverity.Level.UNKNOWN, UsageSeverity.level(-1.0))
        assertEquals(UsageSeverity.Level.NORMAL, UsageSeverity.level(69.9))
        assertEquals(UsageSeverity.Level.WARNING, UsageSeverity.level(70.0))
        assertEquals(UsageSeverity.Level.WARNING, UsageSeverity.level(82.0))
        assertEquals(UsageSeverity.Level.WARNING, UsageSeverity.level(89.9))
        assertEquals(UsageSeverity.Level.CRITICAL, UsageSeverity.level(90.0))
        assertEquals(UsageSeverity.Level.CRITICAL, UsageSeverity.level(100.0))
        assertEquals(0xFFFFA93D, UsageSeverity.color(100.0 - 18.0))
        assertEquals(0xFFFF6B6B, UsageSeverity.color(90.0))
        assertEquals(0xFF7f541e, UsageSeverity.color(82.0, onPaper = true))
    }
}
