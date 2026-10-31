package dev.agentdeck.net

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class DotAuthorizationTest {
    @Test fun waterCurrentClosesAndReducedMotionStaysAtHome() {
        val start = DotHabitatRules.offset(3.0, true, true)
        val end = DotHabitatRules.offset(3.0 + DotHabitatRules.periodSeconds, true, true)
        assertEquals(start.first, end.first, 0.000001)
        assertEquals(start.second, end.second, 0.000001)
        assertEquals(0.0 to 0.0, DotHabitatRules.offset(3.0, true, false))
        assertEquals(0.0 to 0.0, DotHabitatRules.offset(3.0, false, true))
    }
    @Test fun authorizationIsIndependentOfConfigurationAndRevocationStopsWork() {
        val now = 1800000000000L
        val frame = DotSurfaceSnapshot(configured = true, hosting = true,
            reportState = "working", reportedAt = now, expiresAt = now + 10000)
        assertEquals(2, frame.effectiveCode(now))
        assertEquals(true, frame.inhabitsHabitat(now))
        assertEquals(false, frame.copy(authorized = false).inhabitsHabitat(now))
        assertEquals(false, frame.copy(reportState = null).inhabitsHabitat(now))
        assertEquals(false, frame.inhabitsHabitat(now + 10001))
        assertEquals(8, frame.copy(authorized = false).effectiveCode(now))
        assertEquals(2, frame.copy(authorized = true).effectiveCode(now))
        assertEquals(0, frame.copy(authorized = true, reportState = null).effectiveCode(now))
        assertEquals(1, frame.copy(hosting = false, authorized = false).effectiveCode(now))
        val legacy = Json.decodeFromString<DotSurfaceSnapshot>("""{"configured":true,"hosting":true}""")
        assertEquals(null, legacy.authorized)
        assertEquals(0, legacy.effectiveCode(now))
    }
}
