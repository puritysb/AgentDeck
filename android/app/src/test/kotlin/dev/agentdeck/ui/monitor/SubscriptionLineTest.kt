package dev.agentdeck.ui.monitor

import dev.agentdeck.net.SubscriptionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/**
 * Guards subscription rendering against stale Codex `subscription_active_until`
 * dates. When the user renews ChatGPT Plus but does not re-run `codex login`,
 * ~/.codex/auth.json keeps the previous JWT and the claim lags behind the real
 * billing state — surfacing "ChatGPT Plus · 2025-03-04" forever is misleading,
 * so the renderer swaps a past date for a `renewal needed` hint that nudges
 * the user toward re-auth without hiding the row entirely.
 */
class SubscriptionLineTest {

    private val now = Instant.parse("2026-05-06T00:00:00Z")

    @Test
    fun `inline plan preserves credits and absent date`() {
        assertEquals("ChatGPT Pro · Premium · 20 credits", withSubscriptionDate("ChatGPT Pro · Premium · 20 credits", null, now))
        assertEquals("Google AI Pro", withSubscriptionDate("Google AI Pro", null, now))
    }

    @Test
    fun `inline date is distinct from quota reset`() {
        val result = withSubscriptionDate("ChatGPT Pro", "2099-01-01", now)!!
        org.junit.Assert.assertTrue(result.startsWith("ChatGPT Pro · subscription "))
        org.junit.Assert.assertFalse(result.contains("reset"))
    }

    @Test
    fun `past subscription date does not claim cancellation`() {
        assertEquals("ChatGPT Pro · subscription date unconfirmed", withSubscriptionDate("ChatGPT Pro", "2020-01-01", now))
    }


    @Test
    fun `future ISO8601 with offset renders date suffix`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2026-12-31T00:00:00Z")
        assertEquals("ChatGPT Plus · 2026-12-31", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `future ISO8601 with fractional seconds renders date suffix`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2026-09-15T12:34:56.789Z")
        assertEquals("ChatGPT Plus · 2026-09-15", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `past until renders renewal needed`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2025-03-04T00:00:00Z")
        assertEquals("ChatGPT Plus · renewal needed", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `null until renders name only`() {
        val sub = SubscriptionInfo(name = "Claude", until = null)
        assertEquals("Claude", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `malformed until renders renewal needed`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "not-a-date")
        assertEquals("ChatGPT Plus · renewal needed", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `bare date string parses as UTC midnight`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2026-12-31")
        assertEquals("ChatGPT Plus · 2026-12-31", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `bare date in past renders renewal needed`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2024-01-01")
        assertEquals("ChatGPT Plus · renewal needed", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `subscriptionTrailing flags expired for past dates`() {
        val trailing = subscriptionTrailing("2025-03-04T00:00:00Z", now)
        assertNotNull(trailing)
        assertEquals("renewal needed", trailing!!.text)
        assertEquals(true, trailing.expired)
    }

    @Test
    fun `subscriptionTrailing returns date for future`() {
        val trailing = subscriptionTrailing("2099-01-01T00:00:00Z", now)
        assertNotNull(trailing)
        assertEquals(false, trailing!!.expired)
        assertEquals("2099-01-01", trailing.text)
    }

    @Test
    fun `subscriptionTrailing returns null for blank or null`() {
        assertNull(subscriptionTrailing(null, now))
        assertNull(subscriptionTrailing("", now))
        assertNull(subscriptionTrailing("   ", now))
    }

    @Test
    fun `parseUntilInstant accepts blank as null`() {
        assertNull(parseUntilInstant(""))
        assertNull(parseUntilInstant("   "))
    }

    @Test
    fun `parseUntilInstant accepts ISO8601`() {
        assertNotNull(parseUntilInstant("2099-01-01T00:00:00Z"))
    }
}
