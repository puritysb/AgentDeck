package dev.agentdeck.net

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class DotAuthorizationTest {
    @Test fun authorizationIsIndependentOfConfigurationAndRevocationStopsWork() {
        val now = 1800000000000L
        val frame = DotSurfaceSnapshot(configured = true, hosting = true,
            reportState = "working", reportedAt = now, expiresAt = now + 10000)
        assertEquals(2, frame.effectiveCode(now))
        assertEquals(8, frame.copy(authorized = false).effectiveCode(now))
        assertEquals(2, frame.copy(authorized = true).effectiveCode(now))
        assertEquals(0, frame.copy(authorized = true, reportState = null).effectiveCode(now))
        assertEquals(1, frame.copy(hosting = false, authorized = false).effectiveCode(now))
        val legacy = Json.decodeFromString<DotSurfaceSnapshot>("""{"configured":true,"hosting":true}""")
        assertEquals(null, legacy.authorized)
        assertEquals(0, legacy.effectiveCode(now))
    }
}
