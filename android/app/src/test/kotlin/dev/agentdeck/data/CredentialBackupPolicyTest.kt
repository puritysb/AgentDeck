package dev.agentdeck.data

import android.content.pm.ApplicationInfo
import dev.agentdeck.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.xmlpull.v1.XmlPullParser

@RunWith(RobolectricTestRunner::class)
class CredentialBackupPolicyTest {
    @Test fun `packaged app disables backup and excludes credentials from both transfer mechanisms`() {
        val app = RuntimeEnvironment.getApplication()
        assertFalse(app.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP != 0)
        val sensitiveDomains = setOf("root", "file", "database", "sharedpref", "external",
            "device_root", "device_file", "device_database", "device_sharedpref")
        for ((resource, sections) in listOf(
            R.xml.backup_rules to setOf("full-backup-content"),
            R.xml.data_extraction_rules to setOf("cloud-backup", "device-transfer"),
        )) {
            app.resources.getXml(resource).use { parser ->
                var section = ""
                val exclusions = mutableMapOf<String, MutableSet<String>>()
                while (parser.eventType != XmlPullParser.END_DOCUMENT) {
                    if (parser.eventType == XmlPullParser.START_TAG) {
                        if (parser.name in sections) section = parser.name
                        assertFalse("No backup include may override the credential exclusion", parser.name == "include")
                        if (parser.name == "exclude" && parser.getAttributeValue(null, "path") == ".") {
                            exclusions.getOrPut(section) { mutableSetOf() }.add(parser.getAttributeValue(null, "domain"))
                        }
                    }
                    parser.next()
                }
                assertEquals(sections, exclusions.keys)
                for (domains in exclusions.values) assertEquals(sensitiveDomains, domains)
            }
        }
    }
}
