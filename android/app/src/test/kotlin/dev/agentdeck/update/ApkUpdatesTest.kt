package dev.agentdeck.update

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ApkUpdatesTest {
    @Test fun versionsAreNumericAndStableOnly() {
        assertTrue(ApkUpdates.newer("1.10.0", "1.9.9"))
        assertFalse(ApkUpdates.newer("1.4.0", "1.4.0"))
        assertFalse(ApkUpdates.newer("1.3.9", "1.4.0"))
        assertFalse(ApkUpdates.newer("2.0.0-beta", "1.4.0"))
        assertFalse(ApkUpdates.newer("999999999999999999999.0.0", "1.4.0"))
    }
    private fun release(tag: String = "android-v1.4.1", url: String = "https://github.com/puritysb/AgentDeck/releases/download/android-v1.4.1/agentdeck-v1.4.1.apk", digest: String = "sha256:" + "a".repeat(64), size: Long = 1000, prerelease: Boolean = false) = Json.parseToJsonElement("""
        {"tag_name":"$tag","draft":false,"prerelease":$prerelease,"assets":[{"name":"agentdeck-v1.4.1.apk","size":$size,"digest":"$digest","browser_download_url":"$url"}]}
    """).jsonObject
    @Test fun onlyOfficialBoundedStableAndroidAssetsAreAccepted() {
        assertEquals("1.4.1", ApkUpdates.parseRelease(release())?.version)
        assertNull(ApkUpdates.parseRelease(release(tag = "apple-v1.4.1")))
        assertNull(ApkUpdates.parseRelease(release(url = "https://example.com/app.apk")))
        assertNull(ApkUpdates.parseRelease(release(digest = "")))
        assertNull(ApkUpdates.parseRelease(release(size = 0)))
        assertNull(ApkUpdates.parseRelease(release(size = 100_000_000)))
        assertNull(ApkUpdates.parseRelease(release(prerelease = true)))
    }

    @Test
    fun `signer set falls back to legacy signatures when signingInfo is empty`() {
        // What API 28-29 return for a v2-only archive read with GET_SIGNING_CERTIFICATES.
        val signature = android.content.pm.Signature("3082010a")
        val archive = android.content.pm.PackageInfo().apply { signatures = arrayOf(signature) }
        assertEquals(setOf(signature.toCharsString()), ApkUpdates.signerSet(archive))
        assertTrue(ApkUpdates.signerSet(android.content.pm.PackageInfo()).isEmpty())
    }
}
